import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  AgentRuntime,
  createBuiltinTools,
  MutationCoordinator,
  ToolGateway,
  WorkspaceRoots,
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
    const before = snapshotWorkspace(workspace);
    const traceStore = new MemoryTraceStore();
    const allowedTools = new Set(definition.allowedTools);
    const gateway = new ToolGateway({
      traceStore,
      now: deterministicClock(),
      defaultRetry: false,
      approvalPolicy: ({ tool }) =>
        allowedTools.has(tool.name)
          ? { action: 'allow' }
          : {
              action: 'deny',
              reason: `Tool ${tool.name} is outside the eval allowlist`
            }
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
    const runtime = new AgentRuntime({
      traceStore,
      llmClient: llm,
      toolGateway: gateway,
      maxToolIterations: definition.limits.maxIterations,
      createRunId: () => `eval-${definition.id}`,
      now: deterministicClock(),
      workspaceRoot: workspace,
      workspaceRoots: new WorkspaceRoots(workspace),
      mutationCoordinator: mutations
    });
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(new Error('Eval case timed out')),
      definition.limits.timeoutMs
    );
    timeout.unref();

    let result: AgentResult | undefined;
    let runtimeError: unknown;
    try {
      result = await runtime.run({
        input: definition.prompt,
        requestedMode: definition.mode,
        signal: abort.signal
      });
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
    const assertions = evaluateAssertions({
      definition,
      result,
      changedFiles,
      verification,
      toolCalls
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
    return {
      report,
      ...(shouldKeep ? { retainedWorkspacePath: workspace } : {})
    };
  } catch (error) {
    shouldKeep = true;
    const report = evalReportSchema.parse({
      schemaVersion: 1,
      caseId: definition.id,
      description: definition.description,
      deterministic: true,
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
    return { report, retainedWorkspacePath: workspace };
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
      ok: result.status === 0 && !result.error,
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
}): Array<{ name: string; passed: boolean; details: string }> {
  const changed = new Set(input.changedFiles.map((file) => file.path));
  const called = new Set(input.toolCalls.map((call) => call.name));
  const assertions = [
    {
      name: 'result-status',
      passed: input.result?.status === input.definition.assertions.resultStatus,
      details: `expected=${input.definition.assertions.resultStatus} actual=${input.result?.status ?? 'none'}`
    },
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
    ...input.verification.map((verification) => ({
      name: `verification:${verification.name}`,
      passed: verification.ok,
      details: verification.ok ? 'passed' : 'failed'
    }))
  ];
  return assertions;
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
