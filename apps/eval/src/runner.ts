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
import { z } from 'zod';

import {
  AgentRuntime,
  createBuiltinTools,
  MutationCoordinator,
  SessionContext,
  ToolGateway,
  WorkspaceRoots,
  type AgentRuntimeOptions,
  type AgentResult,
  type LlmCallMetrics,
  type LlmCapabilities,
  type LlmClient,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmUsage,
  type ToolDefinition,
  type ThinkingEffort,
  replayTraceEvents,
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

export type EvalTarget =
  | { kind: 'fixture' }
  | {
      kind: 'provider';
      client: LlmClient;
      provider: LlmProvider;
      model: string;
      maxCostUsd: number;
    };

export interface RunEvalCaseOptions {
  packageRoot: string;
  keepWorkspace?: boolean;
  applicationVersion?: string;
  attempt?: number;
  target?: EvalTarget;
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
  const target = options.target ?? { kind: 'fixture' as const };
  const attempt = options.attempt ?? 1;
  const startedAt = performance.now();
  let shouldKeep = options.keepWorkspace === true;

  try {
    validateTarget(definition, target);
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
    const now =
      target.kind === 'fixture'
        ? deterministicClock()
        : () => new Date();
    const allowedTools = new Set(
      target.kind === 'fixture'
        ? definition.allowedTools
        : realProviderTools(definition.allowedTools)
    );
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
      now,
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
    if (target.kind === 'provider' && allowedTools.has('Verify')) {
      availableTools.set(
        'Verify',
        createEvalVerifyTool(definition, workspace)
      );
    }
    for (const name of allowedTools) {
      const tool = availableTools.get(name);
      if (!tool) {
        throw new EvalConfigurationError(
          `Case ${definition.id} references unavailable tool ${name}`
        );
      }
      gateway.register(tool);
    }

    const fixtureLlm =
      target.kind === 'fixture'
        ? new FixtureLlmClient(definition.fixtureResponses!)
        : undefined;
    const providerMeter =
      target.kind === 'provider'
        ? new EvalLlmMeter(target.client, target.maxCostUsd)
        : undefined;
    const llm: LlmClient = fixtureLlm ?? providerMeter!;
    let runSequence = 0;
    const baseRuntimeOptions: AgentRuntimeOptions = {
      traceStore,
      llmClient: llm,
      toolGateway: gateway,
      maxToolIterations: definition.limits.maxIterations,
      createRunId: () => `eval-${definition.id}-${++runSequence}`,
      now,
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
    let traceReplayError: string | undefined;
    if (result) {
      try {
        replayTraceEvents(
          result.runId,
          traceStore.events.filter((event) => event.runId === result.runId)
        );
      } catch (error) {
        traceReplayError =
          error instanceof Error ? error.message : String(error);
      }
    } else {
      traceReplayError = 'run did not produce a result';
    }
    const assertions = evaluateAssertions({
      definition,
      targetKind: target.kind,
      result,
      changedFiles,
      verification,
      toolCalls,
      traceEvents,
      traceReplayError,
      budget:
        target.kind === 'provider'
          ? providerMeter!.budgetAssessment()
          : undefined
    });
    const passed = assertions.every((assertion) => assertion.passed);
    const timedOut = abort.signal.aborted;
    const budgetFailed = assertions.some(
      (assertion) => assertion.name === 'cost-budget' && !assertion.passed
    );
    const status = timedOut
      ? 'timeout' as const
      : runtimeError
        ? 'error' as const
        : passed
          ? 'passed' as const
          : 'failed' as const;
    const failedVerification = verification.some((item) => !item.ok);
    const usage =
      target.kind === 'fixture'
        ? {
            ...fixtureLlm!.usage,
            estimatedCostUsd: 0
          }
        : providerMeter!.reportUsage();
    const report = evalReportSchema.parse({
      schemaVersion: 1,
      caseId: definition.id,
      attempt,
      description: definition.description,
      deterministic: target.kind === 'fixture',
      workflow: definition.workflow.kind,
      runtime: {
        applicationVersion,
        promptVersion: EVAL_PROMPT_VERSION,
        provider: target.kind === 'fixture' ? 'fixture' : target.provider,
        model:
          target.kind === 'fixture'
            ? fixtureLlm!.model
            : target.model
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
      durationMs:
        target.kind === 'fixture'
          ? 0
          : Math.max(0, Math.round(performance.now() - startedAt)),
      usage,
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
          : budgetFailed
            ? 'budget'
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
      providerErrorCategory:
        target.kind === 'provider'
          ? providerErrorCategory(traceStore.events)
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
      attempt,
      description: definition.description,
      deterministic: target.kind === 'fixture',
      workflow: definition.workflow.kind,
      runtime: {
        applicationVersion,
        promptVersion: EVAL_PROMPT_VERSION,
        provider: target.kind === 'fixture' ? 'fixture' : target.provider,
        model:
          target.kind === 'fixture' ? 'fixture-script-v1' : target.model
      },
      status: 'error',
      score: { earned: 0, possible: 0 },
      changedFiles: [],
      verification: [],
      toolCalls: [],
      traceEvents: [],
      toolIterations: 0,
      durationMs:
        target.kind === 'fixture'
          ? 0
          : Math.max(0, Math.round(performance.now() - startedAt)),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        ...(target.kind === 'fixture' ? { estimatedCostUsd: 0 } : {})
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

class EvalCostBudgetError extends Error {
  override readonly name = 'EvalCostBudgetError';
}

class EvalLlmMeter implements LlmClient {
  private inputTokens = 0;
  private outputTokens = 0;
  private totalTokens = 0;
  private completedCalls = 0;
  private pricedCalls = 0;
  private estimatedCostUsd = 0;

  constructor(
    private readonly inner: LlmClient,
    private readonly maxCostUsd: number
  ) {}

  get provider(): LlmProvider {
    return this.inner.provider;
  }

  get model(): string | undefined {
    return this.inner.model;
  }

  get capabilities(): LlmCapabilities | undefined {
    return this.inner.capabilities;
  }

  get thinkingEffort(): ThinkingEffort | undefined {
    return this.inner.thinkingEffort;
  }

  get contextWindow(): number | undefined {
    return this.inner.contextWindow;
  }

  get lastUsage(): LlmUsage | undefined {
    return this.inner.lastUsage;
  }

  get lastCallMetrics(): LlmCallMetrics | undefined {
    return this.inner.lastCallMetrics;
  }

  setModel(model: string): void {
    if (!this.inner.setModel) {
      throw new Error('当前 Eval Provider 不支持切换模型');
    }
    this.inner.setModel(model);
  }

  setThinkingEffort(effort: ThinkingEffort): void {
    if (!this.inner.setThinkingEffort) {
      throw new Error('当前 Eval Provider 不支持切换思考强度');
    }
    this.inner.setThinkingEffort(effort);
  }

  clearLastUsage(): void {
    this.inner.clearLastUsage?.();
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.checkBudget();
    const response = await this.inner.complete(request);
    this.recordUsage(response.usage);
    return response;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.checkBudget();
    for await (const chunk of this.inner.stream(request)) {
      if (chunk.type === 'done') this.recordUsage(chunk.usage);
      yield chunk;
    }
  }

  reportUsage(): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd?: number;
  } {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens,
      ...(this.completedCalls > 0 && this.pricedCalls === this.completedCalls
        ? { estimatedCostUsd: this.estimatedCostUsd }
        : {})
    };
  }

  budgetAssessment(): { passed: boolean; details: string } {
    if (this.completedCalls === 0) {
      return { passed: true, details: 'no completed provider calls' };
    }
    if (this.pricedCalls !== this.completedCalls) {
      return {
        passed: false,
        details:
          `pricing unavailable for ${this.completedCalls - this.pricedCalls} ` +
          `of ${this.completedCalls} completed calls`
      };
    }
    return {
      passed: this.estimatedCostUsd <= this.maxCostUsd,
      details:
        `limit=$${this.maxCostUsd.toFixed(6)} ` +
        `actual=$${this.estimatedCostUsd.toFixed(6)}`
    };
  }

  private checkBudget(): void {
    if (
      this.pricedCalls === this.completedCalls &&
      this.completedCalls > 0 &&
      this.estimatedCostUsd >= this.maxCostUsd
    ) {
      throw new EvalCostBudgetError(
        `Eval cost budget reached: $${this.estimatedCostUsd.toFixed(6)} ` +
        `>= $${this.maxCostUsd.toFixed(6)}`
      );
    }
  }

  private recordUsage(usage: LlmUsage | undefined): void {
    this.completedCalls += 1;
    this.inputTokens += usage?.inputTokens ?? 0;
    this.outputTokens += usage?.outputTokens ?? 0;
    this.totalTokens +=
      usage?.totalTokens ??
      (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    if (usage?.estimatedCostUsd !== undefined) {
      this.pricedCalls += 1;
      this.estimatedCostUsd += usage.estimatedCostUsd;
    }
  }
}

function validateTarget(definition: EvalCase, target: EvalTarget): void {
  if (target.kind === 'fixture') {
    if (!definition.fixtureResponses?.length) {
      throw new EvalConfigurationError(
        `Case ${definition.id} has no fixtureResponses`
      );
    }
    return;
  }
  if (!definition.realProvider.enabled) {
    throw new EvalConfigurationError(
      `Case ${definition.id} is not enabled for real Provider evaluation`
    );
  }
  if (definition.workflow.kind !== 'run') {
    throw new EvalConfigurationError(
      `Real Provider evaluation currently supports only run workflows`
    );
  }
  if (!Number.isFinite(target.maxCostUsd) || target.maxCostUsd <= 0) {
    throw new EvalConfigurationError('Real Provider Eval requires a positive budget');
  }
}

function realProviderTools(configured: string[]): string[] {
  const tools = new Set(configured);
  if (tools.delete('Bash')) tools.add('Verify');
  for (const name of [
    'ProcessStart',
    'ProcessWrite',
    'ProcessPoll',
    'ProcessKill',
    'Task'
  ]) {
    tools.delete(name);
  }
  return [...tools];
}

function providerErrorCategory(
  events: TraceEvent[]
): EvalReport['providerErrorCategory'] {
  const known = new Set([
    'authentication',
    'permission',
    'rate-limit',
    'invalid-request',
    'server',
    'network',
    'timeout',
    'aborted',
    'unknown'
  ]);
  for (const event of [...events].reverse()) {
    const metrics = asRecord(event.payload.metrics);
    const category = metrics?.errorCategory;
    if (typeof category === 'string' && known.has(category)) {
      return category as EvalReport['providerErrorCategory'];
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined;
}

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
        ...evalCommandEnvironment(),
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

function createEvalVerifyTool(
  definition: EvalCase,
  workspace: string
): ToolDefinition<{ command: string }> {
  const commands = definition.verification.map((item) => ({
    ...item,
    display: [item.command, ...item.args].join(' ')
  }));
  if (commands.length === 0) {
    throw new EvalConfigurationError(
      `Case ${definition.id} enables Bash but declares no verification commands`
    );
  }
  const allowed = new Map(commands.map((item) => [item.display, item]));
  return {
    name: 'Verify',
    description:
      '运行本 Eval Case 声明的验证命令。只接受工具参数中列出的完整命令，不启动 shell。',
    risk: 'execute',
    category: 'shell',
    retry: false,
    inputSchema: z.object({
      command: z.string().refine((value) => allowed.has(value), {
        message: 'command is not declared by this Eval Case'
      })
    }),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: commands.map((item) => item.display),
          description: '必须原样选择一个已声明的验证命令'
        }
      },
      required: ['command'],
      additionalProperties: false
    },
    redactInputForTrace: (input) => {
      const command = (input as { command: string }).command;
      return {
        verificationCommand: command,
        verificationKinds: verificationKinds(command)
      };
    },
    execute: async (context) => {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error('Eval verification aborted');
      }
      const selected = allowed.get(context.input.command)!;
      const result = spawnSync(selected.command, selected.args, {
        cwd: workspace,
        encoding: 'utf8',
        timeout: selected.timeoutMs,
        env: evalCommandEnvironment()
      });
      if (result.error && result.status === null) throw result.error;
      const output = normalizeOutput(`${result.stdout ?? ''}${result.stderr ?? ''}`);
      return {
        content: output || '(无输出)',
        summary: `exit=${result.status ?? 1}`,
        data: {
          exitCode: result.status ?? 1,
          verificationKinds: verificationKinds(selected.display)
        }
      };
    }
  };
}

function verificationKinds(command: string): string[] {
  const normalized = command.toLowerCase();
  return [
    normalized.includes('test') ? 'test' : undefined,
    normalized.includes('typecheck') || normalized.includes('tsc')
      ? 'typecheck'
      : undefined,
    normalized.includes('build') ? 'build' : undefined,
    normalized.includes('lint') ? 'lint' : undefined
  ].filter((kind): kind is string => kind !== undefined);
}

function evalCommandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'XAI_API_KEY',
    'GH_TOKEN',
    'GITHUB_TOKEN'
  ]) {
    delete env[name];
  }
  return env;
}

function evaluateAssertions(input: {
  definition: EvalCase;
  targetKind: EvalTarget['kind'];
  result?: AgentResult;
  changedFiles: Array<{ path: string; kind: string }>;
  verification: Array<{ name: string; ok: boolean }>;
  toolCalls: Array<{ name: string; status: string }>;
  traceEvents: string[];
  traceReplayError?: string;
  budget?: { passed: boolean; details: string };
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
      name: 'trace-replay',
      passed: input.traceReplayError === undefined,
      details: input.traceReplayError ?? 'strict replay passed'
    },
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
    ...(input.targetKind === 'fixture'
      ? input.definition.assertions.requiredToolCalls.map((name) => ({
          name: `required-tool:${name}`,
          passed: called.has(name),
          details: called.has(name) ? 'called' : 'not-called'
        }))
      : []),
    ...input.definition.assertions.forbiddenToolCalls.map((name) => ({
      name: `forbidden-tool:${name}`,
      passed: !called.has(name),
      details: called.has(name) ? 'called' : 'not-called'
    })),
    ...(input.targetKind === 'fixture'
      ? [
          ...Object.entries(input.definition.assertions.toolCallCounts).map(
            ([name, expected]) => ({
              name: `tool-count:${name}`,
              passed: (toolCallCounts[name] ?? 0) === expected,
              details:
                `expected=${expected} actual=${toolCallCounts[name] ?? 0}`
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
          }))
        ]
      : []),
    ...input.verification.map((verification) => ({
      name: `verification:${verification.name}`,
      passed: verification.ok,
      details: verification.ok ? 'passed' : 'failed'
    })),
    ...(input.budget
      ? [{
          name: 'cost-budget',
          passed: input.budget.passed,
          details: input.budget.details
        }]
      : [])
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
          'Git',
          'Git:status',
          'Git:diff:unstaged',
          'Git:diff:staged'
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
