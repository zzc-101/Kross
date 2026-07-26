import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  AgentRuntime,
  createBuiltinTools,
  MutationCoordinator,
  SessionContext,
  ToolGateway,
  WorkspaceRoots,
  type AgentRuntimeOptions,
  type AgentResult,
  type TraceEvent,
  type TraceStore
} from '@kross/core';

import { FixtureLlmClient } from './fixtureLlm';
import {
  evalCaseSchema,
  evalReportSchema,
  type EvalCase,
  type EvalReport
} from './schema';

const EVAL_PROMPT_VERSION = 1;
const FIXED_TIME = Date.parse('2026-01-01T00:00:00.000Z');

interface RunEvalCaseOptions {
  packageRoot: string;
  keepWorkspace?: boolean;
  applicationVersion?: string;
}

export interface EvalRunOutcome {
  report: EvalReport;
  retainedWorkspacePath?: string;
  reportPath?: string;
}

export async function runEvalCase(
  input: EvalCase,
  options: RunEvalCaseOptions
): Promise<EvalRunOutcome> {
  const definition = evalCaseSchema.parse(input);
  const temporaryRoot = mkdtempSync(join(tmpdir(), `kross-eval-${definition.id}-`));
  const workspace = join(temporaryRoot, 'workspace');
  const fixturePath = resolve(options.packageRoot, definition.fixture);
  const applicationVersion =
    options.applicationVersion ?? readApplicationVersion(options.packageRoot);
  let shouldKeep = options.keepWorkspace === true;

  try {
    if (!statSync(fixturePath).isDirectory()) {
      throw new Error(`Fixture is not a directory: ${fixturePath}`);
    }
    cpSync(fixturePath, workspace, { recursive: true });
    if (definition.workflow.kind === 'conductor') {
      initializeGitFixture(workspace);
    } else {
      linkRepositoryDependencies(options.packageRoot, workspace);
    }
    const before = snapshotWorkspace(workspace);
    const traceStore = new MemoryTraceStore();
    const allowedTools = new Set(definition.allowedTools);
    const evalApprovalPolicy = ({ tool }: {
      tool: { name: string };
    }) =>
      allowedTools.has(tool.name)
        ? definition.workflow.kind === 'checkpoint-resume' &&
          definition.workflow.approvalTool === tool.name
          ? { action: 'ask' as const, reason: 'Eval checkpoint boundary' }
          : { action: 'allow' as const }
        : {
            action: 'deny' as const,
            reason: `Tool ${tool.name} is outside the eval allowlist`
          };
    const gateway = new ToolGateway({
      traceStore,
      now: deterministicClock(),
      defaultRetry: false,
      approvalPolicy: evalApprovalPolicy
    });
    const krossHome = join(temporaryRoot, '.kross');
    const mutations = new MutationCoordinator(krossHome);
    const availableTools = new Map(
      createBuiltinTools(workspace, {
        mutationService: mutations.forWorkspace(workspace)
      }).map((tool) => [tool.name, tool])
    );
    for (const name of allowedTools) {
      const tool = availableTools.get(name);
      if (!tool) {
        throw new EvalConfigurationError(
          `Case ${definition.id} references unavailable tool ${name}`
        );
      }
      gateway.register(tool);
    }

    const llm = new FixtureLlmClient(definition.fixtureResponses);
    const baseRuntimeOptions: AgentRuntimeOptions = {
      traceStore,
      llmClient: llm,
      toolGateway: gateway,
      maxToolIterations: definition.limits.maxIterations,
      createRunId: () => `eval-${definition.id}`,
      now: deterministicClock(),
      workspaceRoot: workspace,
      workspaceRoots: new WorkspaceRoots(workspace),
      mutationCoordinator: mutations,
      runSubagent:
        definition.workflow.kind === 'conductor'
          ? createConductorFixtureRunner(definition, workspace)
          : undefined
    };
    const createRuntime = (sessionContext?: SessionContext) => {
      const created = new AgentRuntime({
        ...baseRuntimeOptions,
        sessionContext
      });
      created.setPermissionMode('auto');
      gateway.setApprovalPolicy(evalApprovalPolicy);
      return created;
    };
    let runtime = createRuntime();
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(new Error('Eval case timed out')),
      definition.limits.timeoutMs
    );
    timeout.unref();

    let result: AgentResult | undefined;
    let runtimeError: unknown;
    try {
      if (definition.workflow.kind === 'checkpoint-resume') {
        const pending = await runtime.run({
          input: definition.prompt,
          requestedMode: definition.mode,
          signal: abort.signal
        });
        if (
          pending.status !== 'approval-required' ||
          pending.pendingApproval?.toolName !==
            definition.workflow.approvalTool
        ) {
          throw new EvalConfigurationError(
            `Case ${definition.id} did not stop at the expected approval boundary`
          );
        }
        const contextState = runtime.exportContextState();
        const workState = runtime.exportWorkState();
        const restoredContext = new SessionContext();
        if (
          !restoredContext.restoreState(contextState, {
            preserveOpenTurn: true
          })
        ) {
          throw new Error('Eval could not restore the open conversation turn');
        }
        runtime = createRuntime(restoredContext);
        if (!runtime.restoreWorkState(workState)) {
          throw new Error('Eval could not restore the run checkpoint');
        }
        result = await runtime.resolveToolApproval({
          runId: pending.runId,
          approved: true,
          signal: abort.signal
        });
      } else if (definition.workflow.kind === 'conductor') {
        const pending = await runtime.run({
          input: definition.prompt,
          requestedMode: 'conductor',
          approvals: { plan: false },
          signal: abort.signal
        });
        if (pending.cancellationReason !== 'approval-gate') {
          throw new EvalConfigurationError(
            `Case ${definition.id} did not produce a Conductor plan`
          );
        }
        result = await runtime.run({
          input: definition.prompt,
          requestedMode: 'conductor',
          approvals: { plan: true },
          signal: abort.signal
        });
      } else {
        result = await runtime.run({
          input: definition.prompt,
          requestedMode: definition.mode,
          signal: abort.signal
        });
      }
    } catch (error) {
      runtimeError = error;
    } finally {
      clearTimeout(timeout);
    }

    const after = snapshotWorkspace(workspace);
    const changedFiles = diffSnapshots(before, after);
    const verification = runVerification(definition, workspace);
    const toolCalls = traceStore.events
      .filter(
        (event) =>
          event.type === 'tool_call.completed' ||
          event.type === 'tool_call.failed'
      )
      .map((event) => ({
        name: String(event.payload.toolName ?? 'unknown'),
        status:
          event.type === 'tool_call.completed'
            ? 'completed' as const
            : 'failed' as const
      }));
    const traceEvents = traceStore.events.map((event) => event.type);
    const assertions = evaluateAssertions({
      definition,
      result,
      changedFiles,
      verification,
      toolCalls,
      traceEvents
    });
    const passed = assertions.every((assertion) => assertion.passed);
    const timedOut = abort.signal.aborted;
    const status = timedOut
      ? 'timeout' as const
      : runtimeError
        ? 'error' as const
        : passed
          ? 'passed' as const
          : 'failed' as const;
    const failedVerification = verification.some((item) => !item.ok);
    const report = evalReportSchema.parse({
      schemaVersion: 1,
      caseId: definition.id,
      description: definition.description,
      deterministic: true,
      workflow: definition.workflow.kind,
      runtime: {
        applicationVersion,
        promptVersion: EVAL_PROMPT_VERSION,
        provider: 'fixture',
        model: llm.model
      },
      status,
      score: {
        earned: assertions.filter((assertion) => assertion.passed).length,
        possible: assertions.length
      },
      changedFiles,
      verification,
      toolCalls,
      traceEvents,
      toolIterations: maxToolIteration(traceStore.events),
      durationMs: 0,
      usage: {
        ...llm.usage,
        estimatedCostUsd: 0
      },
      result: result
        ? {
            status: result.status,
            verificationStatus: result.report.verification.status
          }
        : undefined,
      assertions,
      failureCategory: timedOut
        ? 'timeout'
        : runtimeError
          ? 'runtime'
          : failedVerification
            ? 'verification'
            : passed
              ? undefined
              : 'assertion',
      error: runtimeError
        ? runtimeError instanceof Error
          ? runtimeError.message
          : String(runtimeError)
        : undefined,
      tags: definition.tags,
      capabilities: definition.capabilities
    });
    shouldKeep ||= report.status !== 'passed';
    const reportPath = shouldKeep
      ? writeRetainedReport(temporaryRoot, report)
      : undefined;
    return {
      report,
      ...(shouldKeep ? { retainedWorkspacePath: workspace } : {}),
      ...(reportPath ? { reportPath } : {})
    };
  } catch (error) {
    shouldKeep = true;
    const report = evalReportSchema.parse({
      schemaVersion: 1,
      caseId: definition.id,
      description: definition.description,
      deterministic: true,
      workflow: definition.workflow.kind,
      runtime: {
        applicationVersion,
        promptVersion: EVAL_PROMPT_VERSION,
        provider: 'fixture',
        model: 'fixture-script-v1'
      },
      status: 'error',
      score: { earned: 0, possible: 0 },
      changedFiles: [],
      verification: [],
      toolCalls: [],
      traceEvents: [],
      toolIterations: 0,
      durationMs: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0
      },
      assertions: [],
      failureCategory:
        error instanceof EvalConfigurationError
          ? 'configuration'
          : 'runtime',
      error: error instanceof Error ? error.message : String(error),
      tags: definition.tags,
      capabilities: definition.capabilities
    });
    return {
      report,
      retainedWorkspacePath: workspace,
      reportPath: writeRetainedReport(temporaryRoot, report)
    };
  } finally {
    if (!shouldKeep) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

class EvalConfigurationError extends Error {}

class MemoryTraceStore implements TraceStore {
  readonly events: TraceEvent[] = [];

  async append(event: TraceEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }

  async listRunIds(): Promise<string[]> {
    return [...new Set(this.events.map((event) => event.runId))];
  }
}

function deterministicClock(): () => Date {
  let tick = 0;
  return () => new Date(FIXED_TIME + tick++);
}

function snapshotWorkspace(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  walk(root, '');
  return snapshot;

  function walk(directory: string, relativeDirectory: string): void {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.kross') continue;
      const absolute = join(directory, entry.name);
      const path = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        walk(absolute, path);
      } else if (entry.isFile()) {
        snapshot.set(
          path,
          createHash('sha256').update(readFileSync(absolute)).digest('hex')
        );
      }
    }
  }
}

function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>
): Array<{ path: string; kind: 'added' | 'modified' | 'deleted' }> {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap((path) => {
    const previous = before.get(path);
    const current = after.get(path);
    if (previous === current) return [];
    return [{
      path,
      kind:
        previous === undefined
          ? 'added' as const
          : current === undefined
            ? 'deleted' as const
            : 'modified' as const
    }];
  });
}

function runVerification(
  definition: EvalCase,
  workspace: string
): Array<{
  name: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return definition.verification.map((verification) => {
    const result = spawnSync(verification.command, verification.args, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: verification.timeoutMs,
      env: {
        ...process.env,
        NO_COLOR: '1'
      }
    });
    return {
      name: verification.name,
      command: [verification.command, ...verification.args].join(' '),
      ok:
        result.status === verification.expectedExitCode &&
        !result.error,
      exitCode: result.status,
      stdout: normalizeOutput(result.stdout),
      stderr: normalizeOutput(
        [result.stderr, result.error?.message].filter(Boolean).join('\n')
      )
    };
  });
}

function evaluateAssertions(input: {
  definition: EvalCase;
  result?: AgentResult;
  changedFiles: Array<{ path: string; kind: string }>;
  verification: Array<{ name: string; ok: boolean }>;
  toolCalls: Array<{ name: string; status: string }>;
  traceEvents: string[];
}): Array<{ name: string; passed: boolean; details: string }> {
  const changed = new Set(input.changedFiles.map((file) => file.path));
  const called = new Set(input.toolCalls.map((call) => call.name));
  const traceEvents = new Set(input.traceEvents);
  const toolCallCounts = input.toolCalls.reduce<Record<string, number>>(
    (counts, call) => {
      counts[call.name] = (counts[call.name] ?? 0) + 1;
      return counts;
    },
    {}
  );
  const assertions = [
    {
      name: 'result-status',
      passed: input.result?.status === input.definition.assertions.resultStatus,
      details: `expected=${input.definition.assertions.resultStatus} actual=${input.result?.status ?? 'none'}`
    },
    ...(input.definition.assertions.verificationStatus
      ? [{
          name: 'verification-status',
          passed:
            input.result?.report.verification.status ===
            input.definition.assertions.verificationStatus,
          details:
            `expected=${input.definition.assertions.verificationStatus} ` +
            `actual=${input.result?.report.verification.status ?? 'none'}`
        }]
      : []),
    ...input.definition.mustChange.map((path) => ({
      name: `must-change:${path}`,
      passed: changed.has(path),
      details: changed.has(path) ? 'changed' : 'unchanged'
    })),
    ...input.definition.mustNotChange.map((path) => ({
      name: `must-not-change:${path}`,
      passed: !changed.has(path),
      details: changed.has(path) ? 'changed' : 'unchanged'
    })),
    ...input.definition.assertions.requiredToolCalls.map((name) => ({
      name: `required-tool:${name}`,
      passed: called.has(name),
      details: called.has(name) ? 'called' : 'not-called'
    })),
    ...input.definition.assertions.forbiddenToolCalls.map((name) => ({
      name: `forbidden-tool:${name}`,
      passed: !called.has(name),
      details: called.has(name) ? 'called' : 'not-called'
    })),
    ...Object.entries(input.definition.assertions.toolCallCounts).map(
      ([name, expected]) => ({
        name: `tool-count:${name}`,
        passed: (toolCallCounts[name] ?? 0) === expected,
        details: `expected=${expected} actual=${toolCallCounts[name] ?? 0}`
      })
    ),
    ...input.definition.assertions.requiredTraceEvents.map((type) => ({
      name: `required-trace:${type}`,
      passed: traceEvents.has(type),
      details: traceEvents.has(type) ? 'observed' : 'missing'
    })),
    ...input.definition.assertions.forbiddenTraceEvents.map((type) => ({
      name: `forbidden-trace:${type}`,
      passed: !traceEvents.has(type),
      details: traceEvents.has(type) ? 'observed' : 'absent'
    })),
    ...input.verification.map((verification) => ({
      name: `verification:${verification.name}`,
      passed: verification.ok,
      details: verification.ok ? 'passed' : 'failed'
    }))
  ];
  return assertions;
}

function linkRepositoryDependencies(
  packageRoot: string,
  workspace: string
): void {
  const repositoryNodeModules = resolve(packageRoot, '../..', 'node_modules');
  const workspaceNodeModules = join(workspace, 'node_modules');
  if (
    existsSync(repositoryNodeModules) &&
    !existsSync(workspaceNodeModules)
  ) {
    symlinkSync(repositoryNodeModules, workspaceNodeModules, 'junction');
  }
}

function initializeGitFixture(workspace: string): void {
  runRequiredCommand('git', ['init', '--quiet'], workspace);
  runRequiredCommand('git', ['add', '--all'], workspace);
  runRequiredCommand(
    'git',
    [
      '-c',
      'user.name=Kross Eval',
      '-c',
      'user.email=kross-eval@localhost',
      'commit',
      '--quiet',
      '--message',
      'fixture baseline'
    ],
    workspace
  );
}

function createConductorFixtureRunner(
  definition: EvalCase,
  workspace: string
): NonNullable<AgentRuntimeOptions['runSubagent']> {
  if (definition.workflow.kind !== 'conductor') {
    throw new EvalConfigurationError(
      `Case ${definition.id} is not a Conductor workflow`
    );
  }
  const workflow = definition.workflow;
  return async (request) => {
    if (request.role === 'worker') {
      for (const change of workflow.workerChanges) {
        const absolute = resolve(workspace, change.path);
        if (
          absolute !== workspace &&
          !absolute.startsWith(`${workspace}/`)
        ) {
          throw new EvalConfigurationError(
            `Conductor change escapes workspace: ${change.path}`
          );
        }
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, change.content, 'utf8');
      }
      const verification =
        workflow.workerVerification === 'passed'
          ? {
              status: 'passed' as const,
              commands: ['fixture verification'],
              evidence: ['fixture verification: passed']
            }
          : workflow.workerVerification === 'failed'
            ? {
                status: 'failed' as const,
                commands: ['fixture verification'],
                evidence: ['fixture verification: failed'],
                reason: 'Fixture worker verification failed'
              }
            : {
                status: 'not-run' as const,
                commands: [],
                evidence: [],
                reason: 'Fixture worker did not run verification'
              };
      return {
        subRunId: `eval-${definition.id}-worker`,
        mode: 'general',
        modeForcedToExplore: false,
        result: {
          status: 'completed',
          summary: 'Fixture worker completed',
          changedFiles: workflow.workerChanges.map((change) => change.path),
          diffSummary: [],
          commandsRun: verification.commands,
          toolsUsed: ['Write', ...(verification.commands.length ? ['Bash'] : [])],
          verification,
          evidence: ['Fixture worker changed the declared files'],
          risks: [],
          needsReview: []
        }
      };
    }

    if (request.role === 'validator') {
      return {
        subRunId: `eval-${definition.id}-validator`,
        mode: 'explore',
        modeForcedToExplore: false,
        result: {
          status:
            workflow.workerVerification === 'failed'
              ? 'failed'
              : 'completed',
          summary: 'Fixture validator inspected worker changes',
          changedFiles: [],
          diffSummary: [],
          commandsRun: ['fixture verification'],
          toolsUsed: ['Read', 'Verify'],
          verification: {
            status:
              workflow.workerVerification === 'failed'
                ? 'failed'
                : 'passed',
            commands: ['fixture verification'],
            evidence: [
              `fixture verification: ${workflow.workerVerification}`
            ]
          },
          evidence: ['Fixture validator completed'],
          risks: [],
          needsReview: []
        }
      };
    }

    const status = runRequiredCommand(
      'git',
      ['status', '--short'],
      workspace
    );
    const unstaged = runRequiredCommand(
      'git',
      ['diff', '--no-ext-diff'],
      workspace
    );
    const staged = runRequiredCommand(
      'git',
      ['diff', '--cached', '--no-ext-diff'],
      workspace
    );
    const toolsUsed = workflow.reviewerInspectsDiff
      ? [
          'GitStatus',
          'GitDiff',
          'GitDiff:unstaged',
          'GitDiff:staged'
        ]
      : [];
    return {
      subRunId: `eval-${definition.id}-reviewer`,
      mode: 'explore',
      modeForcedToExplore: false,
      result: {
        status: 'completed',
        summary:
          `status=${normalizeOutput(status.stdout)} ` +
          `unstagedBytes=${Buffer.byteLength(unstaged.stdout)} ` +
          `stagedBytes=${Buffer.byteLength(staged.stdout)}\n` +
          `VERDICT: ${workflow.reviewerVerdict}`,
        changedFiles: [],
        diffSummary: [],
        commandsRun: [],
        toolsUsed,
        verification: {
          status: 'not-needed',
          commands: [],
          evidence: []
        },
        evidence: ['Fixture reviewer read the final Git diff'],
        risks: [],
        needsReview: []
      }
    };
  };
}

function runRequiredCommand(
  command: string,
  args: string[],
  cwd: string
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' }
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ` +
      normalizeOutput(
        [result.stderr, result.error?.message].filter(Boolean).join('\n')
      )
    );
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

function maxToolIteration(events: TraceEvent[]): number {
  return events.reduce((maximum, event) => {
    const iteration = event.payload.iteration;
    return typeof iteration === 'number' && Number.isInteger(iteration)
      ? Math.max(maximum, iteration)
      : maximum;
  }, 0);
}

function normalizeOutput(value: string | null | undefined): string {
  return (value ?? '').replace(/\r\n/gu, '\n').trim();
}

function writeRetainedReport(
  temporaryRoot: string,
  report: EvalReport
): string {
  const path = join(temporaryRoot, 'report.json');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

function readApplicationVersion(packageRoot: string): string {
  const root = resolve(packageRoot, '../..');
  const packageJson = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8')
  ) as { version: string };
  return packageJson.version;
}

export function caseNameFromPath(path: string): string {
  return basename(path, '.json');
}
