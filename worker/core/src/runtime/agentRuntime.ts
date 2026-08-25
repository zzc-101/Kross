import { EventEmitter } from 'node:events';

import {
  abortMessage,
  isOperationAborted,
  throwIfAborted
} from '../abort';
import {
  type AgentResult,
  type TraceEvent,
  agentResultSchema
} from '../domain';
import {
  type ContextMaintenanceResult,
  SessionContext,
  createSessionContext,
  type ContextSnapshot,
  type SessionContextState
} from '../context/sessionContext';
import {
  formatContextUsage
} from '../llm/modelContextWindows';
import type { ThinkingEffort } from '../llm/thinkingEffort';
import type { LlmCapabilities } from '../llm/providerCapabilities';
import type { LlmCallMetrics } from '../llm/providerObservability';
import type { LlmClient, LlmToolCall } from '../llm/types';
import {
  ToolGateway,
  type ToolMetadata
} from '../tools/toolGateway';
import { extractChangedFilesFromEvents } from '../workspace/changedFiles';
import type { ProjectInstructionsSnapshot } from '../workspace/projectInstructions';
import type { SkillsSnapshot } from '../skills/skillDiscovery';
import {
  isSessionWorkState,
  type SessionWorkStateV1
} from '../session/sessionWorkState';
import type { ManagedProcessSummary } from '../process/processManager';
import type {
  AgentRunInput,
  AgentRunStreamEvent,
  AgentRuntimeOptions,
  RunUsage,
  ResolveToolApprovalInput
} from './agentRuntimeTypes';
import { ModelSession } from './modelSession';
import { SessionServices } from './sessionServices';
import {
  DEFAULT_MAX_TOOL_ITERATIONS,
  RuntimeToolLoop
} from './toolLoop';
import type { CancellationStage } from './streamingToolLoop';
import {
  classifyToolCallPhase,
  phaseForLifecycleEvent,
  type RunPhase
} from './runPhase';
import {
  buildSaasSystemPrompt,
  createSaasCompletionPolicy,
  type AgentCompletionPolicy,
  type AgentExecutionPromptPhase
} from './saasRuntimePolicy';

export { DEFAULT_MAX_TOOL_ITERATIONS } from './toolLoop';

export type {
  AgentRunInput,
  AgentRunStreamEvent,
  AgentRuntimeEvent,
  AgentRuntimeOptions,
  RunUsage,
  ResolveToolApprovalInput
} from './agentRuntimeTypes';

export type { ContextMaintenanceResult } from '../context/sessionContext';

/**
 * 工具调用轮次安全上限（默认）。
 * 一轮 = 模型发 tool_calls → 执行 → 回填再问模型。
 */
export class AgentRuntime extends EventEmitter {
  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly sessionContext: SessionContext;
  private readonly toolGateway: ToolGateway | undefined;
  private readonly toolLoop: RuntimeToolLoop;
  private readonly modelSession: ModelSession;
  private readonly sessionServices: SessionServices;
  private readonly completionPolicy: AgentCompletionPolicy;
  private readonly runPhases = new Map<string, RunPhase>();

  constructor(private readonly options: AgentRuntimeOptions) {
    super();
    this.completionPolicy = createSaasCompletionPolicy();
    this.createRunId =
      options.createRunId ?? (() => `run-${Date.now().toString(36)}`);
    this.now = options.now ?? (() => new Date());
    this.sessionContext =
      options.sessionContext ??
      options.contextManager ??
      createSessionContext({
        client: options.llmClient,
        contextWindow: options.llmClient?.contextWindow
      });
    this.toolGateway = options.toolGateway;
    this.toolLoop = new RuntimeToolLoop({
      listTools: () => this.listVisibleTools(),
      llmClient: options.llmClient,
      toolGateway: this.toolGateway,
      sessionContext: this.sessionContext,
      maxToolIterations: options.maxToolIterations,
      record: (runId, type, payload) => this.record(runId, type, payload),
      attachArtifacts: (result) => this.attachArtifacts(result),
      assessCompletionGate: (runId, originalUserInput) =>
        this.assessRunCompletionGate(runId, originalUserInput),
      completionPolicy: this.completionPolicy,
      buildSystemPrompt: () => this.buildSystemPrompt('agent'),
      observeToolCall: (input) => this.observeToolCall(input),
      setRunPhase: (runId, phase, details) =>
        this.setRunPhase(runId, phase, details),
      commitTurn: () => this.sessionContext.commitTurn(),
      abortTurn: (reason) => this.sessionContext.abortTurn(reason),
      interruptTurn: (reason) => this.sessionContext.interruptTurn(reason),
      appendAssistantForCancel: (summary) =>
        this.sessionContext.appendAssistant(summary),
      syncContextSources: () => this.syncContextSources('agent'),
      onContextMaintained: (runId, maintenance) =>
        this.recordContextMaintenanceEvents(runId, maintenance),
      onCheckpointChanged: () => this.emit('work-state.changed'),
      now: this.now
    });
    this.modelSession = new ModelSession(this.options, (client) => {
      this.toolLoop.setLlmClient(client);
      this.sessionContext.setLlmClient(client);
      this.options.onLlmClientChanged?.(client);
    });
    this.sessionServices = new SessionServices({
      options: this.options,
      sessionContext: this.sessionContext,
      toolGateway: this.toolGateway,
      emitWorkStateChanged: () => this.emit('work-state.changed')
    });
    this.sessionServices.refreshProjectInstructions();
    this.sessionServices.refreshSkills();
    this.sessionServices.syncToolPolicySource();
    this.sessionServices.syncModelProfilesSource();
  }

  /** Subscribe to persisted work-state changes. */
  onWorkStateChanged(listener: () => void): () => void {
    this.on('work-state.changed', listener);
    return () => {
      this.off('work-state.changed', listener);
    };
  }

  listManagedProcesses(): ManagedProcessSummary[] {
    return this.options.processManager?.list() ?? [];
  }

  /** Bind managed process visibility and control to the active persisted session. */
  setManagedProcessSession(sessionId?: string): void {
    this.options.processManager?.setSessionScope(sessionId);
  }

  getModelLabel(): string {
    return this.modelSession.getModelLabel();
  }

  getThinkingEffort(): ThinkingEffort {
    return this.modelSession.getThinkingEffort();
  }

  getLlmCapabilities(): LlmCapabilities | undefined {
    return this.modelSession.getCapabilities();
  }

  getLastLlmCallMetrics(): LlmCallMetrics | undefined {
    return this.modelSession.getLlmClient()?.lastCallMetrics;
  }

  setThinkingEffort(effort: ThinkingEffort): void {
    this.modelSession.setThinkingEffort(effort);
  }

  cycleThinkingEffort(): ThinkingEffort {
    return this.modelSession.cycleThinkingEffort();
  }

  getLlmClient(): LlmClient | undefined {
    return this.modelSession.getLlmClient();
  }

  setLlmClient(client: LlmClient | undefined): void {
    this.modelSession.setLlmClient(client);
  }

  setModel(model: string): void {
    this.modelSession.setModel(model);
  }

  restoreConversation(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): ContextMaintenanceResult {
    const maintenance = this.sessionContext.restoreConversation(messages);
    this.modelSession.getLlmClient()?.clearLastUsage?.();
    this.sessionContext.resetCalibration();
    return maintenance;
  }

  exportContextState(): SessionContextState {
    return this.sessionContext.exportState();
  }

  restoreContextState(
    state: SessionContextState,
    options: { preserveOpenTurn?: boolean } = {}
  ): boolean {
    this.modelSession.getLlmClient()?.clearLastUsage?.();
    this.sessionContext.resetCalibration();
    return this.sessionContext.restoreState(state, options);
  }

  exportWorkState(): SessionWorkStateV1 {
    return {
      ...this.sessionServices.exportWorkState(),
      runCheckpoint: this.toolLoop.exportRunCheckpoint()
    };
  }

  restoreWorkState(state: SessionWorkStateV1): boolean {
    if (!isSessionWorkState(state)) return false;
    const checkpointRestored = this.toolLoop.restoreRunCheckpoint(
      state.runCheckpoint
    );
    if (
      !checkpointRestored &&
      this.sessionContext.getThread().getOpenTurnId()
    ) {
      this.sessionContext.interruptTurn(
        '恢复 checkpoint 失败；待执行工具调用未被重放'
      );
    }
    const workStateRestored = this.sessionServices.restoreWorkState(state);
    return checkpointRestored && workStateRestored;
  }

  getPendingToolApproval(): import('../domain').PendingToolApproval | undefined {
    return this.toolLoop.getPendingToolApproval();
  }

  getTodoStore(): import('../todo/todoStore').TodoStore | undefined {
    return this.sessionServices.getTodoStore();
  }

  syncTodoContextSource(): void {
    this.sessionServices.syncTodoContextSource();
  }

  refreshProjectInstructions(): ProjectInstructionsSnapshot {
    return this.sessionServices.refreshProjectInstructions();
  }

  getProjectInstructions(): ProjectInstructionsSnapshot {
    return this.sessionServices.getProjectInstructions();
  }

  refreshSkills(): SkillsSnapshot {
    return this.sessionServices.refreshSkills();
  }

  getSkills(): SkillsSnapshot {
    return this.sessionServices.getSkills();
  }

  getContextUsage(): {
    usedChars: number;
    usedTokens: number;
    maxTokens: number;
    compactThreshold: number;
    lastUsageTokens?: number;
    label: string;
    ratio: number;
    headerLabel: string;
    headerRatio: number;
    contextWindow: number;
  } {
    const snapshot = this.sessionContext.snapshot(
      this.resolveContextBuildInput().buildContextInput
    );
    const client = this.modelSession.getLlmClient();
    const lastUsageTokens = client?.lastUsage?.inputTokens;
    const usedTokens = snapshot.estimatedTokens;
    const maxTokens = snapshot.inputBudget;
    const compactThreshold = snapshot.compactThreshold;
    const contextWindow = this.sessionContext.getPolicy().contextWindow;
    return {
      usedChars: snapshot.estimatedChars,
      usedTokens,
      maxTokens,
      compactThreshold,
      lastUsageTokens,
      label: formatContextUsage(usedTokens, maxTokens),
      ratio: usedTokens / Math.max(1, compactThreshold),
      headerLabel: formatContextUsage(usedTokens, contextWindow),
      headerRatio: usedTokens / Math.max(1, contextWindow),
      contextWindow
    };
  }

  async getRunUsage(runId: string): Promise<RunUsage | undefined> {
    const events = await this.options.traceStore.readRun(runId);
    return summarizeRunUsage(events);
  }

  async run(input: AgentRunInput): Promise<AgentResult> {
    let result: AgentResult | undefined;
    for await (const event of this.executeRun(input)) {
      if (event.type === 'result') {
        result = event.result;
      }
    }
    if (!result) {
      throw new Error('Run finished without a result event');
    }
    return result;
  }

  async *runStreaming(input: AgentRunInput): AsyncIterable<AgentRunStreamEvent> {
    yield* this.executeRun(input);
  }

  /** 用户可见文本只允许 text-delta / thinking-delta。 */
  private async *executeRun(
    input: AgentRunInput
  ): AsyncIterable<AgentRunStreamEvent> {
    const runId = this.createRunId();

    try {
      await this.record(runId, 'run.started', { input: input.input });
      throwIfAborted(input.signal);
      await this.record(runId, 'planner.started', {});
      throwIfAborted(input.signal);

      if (!this.modelSession.getLlmClient()) {
        const result = await this.finishRunWithoutLlm(runId);
        yield { type: 'result', result };
        return;
      }

      yield* this.runAgentToolLoop(input, runId);
    } catch (error) {
      if (!isOperationAborted(error, input.signal)) {
        throw error;
      }
      const cancelled = await this.completeInterruptedRun({
        runId,
        reason: abortMessage(input.signal),
        stage: 'startup'
      });
      yield { type: 'result', result: cancelled };
    }
  }

  private async *runAgentToolLoop(
    input: AgentRunInput,
    runId: string
  ): AsyncIterable<AgentRunStreamEvent> {
    throwIfAborted(input.signal);
    this.sessionContext.beginTurn(input.input);
    const { buildContextInput, tools } = this.buildPlannerContext();
    const prepared = await this.sessionContext.prepareRequest(
      buildContextInput,
      input.signal
    );
    throwIfAborted(input.signal);
    await this.recordPlannerContext(runId, prepared);

    yield* this.toolLoop.runStreamingToolLoop({
      runId,
      originalUserInput: input.input,
      sessionContext: this.sessionContext,
      buildContextInput,
      tools,
      startIteration: 1,
      firstStreamPurpose: 'planner',
      firstIterationMetadata: {
        includedSources: prepared.includedSources,
        droppedSources: prepared.droppedSources,
        contextReport: prepared.report
      },
      signal: input.signal,
      handlers: {
        onSuccess: async ({ fullText }) => {
          this.toolLoop.clearRunCheckpoint(runId);
          const result = await this.attachArtifacts(
            agentResultSchema.parse({
              runId,
              status: 'completed',
              summary: fullText,
              report: {
                artifacts: [],
                evidence: [],
                incompleteItems: []
              }
            })
          );
          await this.record(runId, 'run.completed', { ...result });
          this.sessionContext.commitTurn();
          return result;
        },
        onSoftLand: async ({ summary }) => {
          this.toolLoop.clearRunCheckpoint(runId);
          this.sessionContext.appendAssistant(summary);
          const landed = await this.attachArtifacts(
            agentResultSchema.parse({
              runId,
              status: 'failed',
              summary,
              report: {
                artifacts: [],
                evidence: [
                  `工具调用达到上限 ${this.options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS} 轮，已软着陆为总结`
                ],
                incompleteItems: ['部分任务可能未执行完，可继续对话推进']
              }
            })
          );
          await this.record(runId, 'run.completed', { ...landed });
          this.sessionContext.commitTurn();
          return landed;
        },
        onStalled: async ({ summary }) => {
          this.toolLoop.clearRunCheckpoint(runId);
          this.sessionContext.appendAssistant(summary);
          const stalled = await this.attachArtifacts(
            agentResultSchema.parse({
              runId,
              status: 'failed',
              summary,
              report: {
                artifacts: [],
                evidence: [
                  summary.includes('连续多轮')
                    ? '主 Agent 连续多轮只有检索或读取，没有产生可识别的执行进展'
                    : '主 Agent 在 Harness 恢复提示后仍重复相同工具调用，且工具结果没有变化'
                ],
                incompleteItems: [
                  '任务尚未完成，需要调整策略后继续',
                  ...(summary.startsWith('无法确认任务完成：') ? [summary] : [])
                ]
              }
            })
          );
          await this.record(runId, 'run.completed', { ...stalled });
          this.sessionContext.commitTurn();
          return stalled;
        },
        onFailure: async (message, classification) => {
          this.toolLoop.clearRunCheckpoint(runId);
          const failed = await this.attachArtifacts(
            agentResultSchema.parse({
              runId,
              status: 'failed',
              summary: `模型请求失败：${message}`,
              report: {
                artifacts: [],
                evidence: [
                  `LLM 请求失败: ${message}`,
                  `错误分类: ${classification.source}/${classification.category}; retryable=${classification.retryable}`
                ],
                incompleteItems: [classification.recovery]
              }
            })
          );
          await this.record(runId, 'run.completed', { ...failed });
          this.sessionContext.interruptTurn(message);
          return failed;
        },
        onCancelled: async ({ reason, stage }) =>
          this.completeInterruptedRun({ runId, reason, stage }).finally(() =>
            this.toolLoop.clearRunCheckpoint(runId)
          )
      }
    });
  }

  private async finishRunWithoutLlm(runId: string): Promise<AgentResult> {
    const missingModel = await this.attachArtifacts(
      agentResultSchema.parse({
        runId,
        status: 'failed',
        summary:
          '未配置模型，无法生成真实回复。请配置 AGENT_LLM_PROVIDER 以及对应的 OPENAI_* 或 ANTHROPIC_* 环境变量后重试。',
        report: {
          artifacts: [],
          evidence: ['未检测到可用 LLM client'],
          incompleteItems: []
        }
      })
    );

    await this.record(runId, 'run.completed', { ...missingModel });
    return missingModel;
  }

  private buildSystemPrompt(phase: AgentExecutionPromptPhase): string {
    return buildSaasSystemPrompt({
      phase,
      activeSkill: this.options.activeSkill
    });
  }

  private applySaasContextSources(): void {
    for (const sourceId of ['project-instructions']) {
      this.sessionContext.removeSource(sourceId);
    }
    for (const source of this.options.memoryContextSources ?? []) {
      this.sessionContext.addSource(source);
    }
  }

  private syncContextSources(phase: AgentExecutionPromptPhase): void {
    this.sessionServices.syncTodoContextSource();
    this.sessionServices.refreshProjectInstructions();
    this.sessionServices.refreshSkills();
    this.sessionServices.syncModelProfilesSource();
    this.sessionServices.syncToolPolicySource();
    void phase;
    this.applySaasContextSources();
  }

  private listVisibleTools(): ToolMetadata[] {
    return this.toolGateway?.listTools() ?? [];
  }

  private buildPlannerContext(): {
    buildContextInput: {
      systemPrompt: string;
      tools: ToolMetadata[];
    };
    tools: ToolMetadata[];
  } {
    const tools = this.listVisibleTools();
    this.syncContextSources('agent');
    return {
      buildContextInput: {
        systemPrompt: this.buildSystemPrompt('agent'),
        tools
      },
      tools
    };
  }

  private async recordPlannerContext(
    runId: string,
    context: ContextSnapshot
  ): Promise<void> {
    await this.record(runId, 'context.built', {
      includedSources: context.includedSources,
      droppedSources: context.droppedSources,
      estimatedChars: context.estimatedChars,
      estimatedTokens: context.estimatedTokens,
      report: context.report
    });
    await this.recordContextMaintenance(runId);
  }

  private resolveContextBuildInput(): {
    buildContextInput: {
      systemPrompt: string;
      tools: ToolMetadata[];
    };
  } {
    const tools = this.listVisibleTools();
    this.syncContextSources('agent');
    return {
      buildContextInput: {
        systemPrompt: this.buildSystemPrompt('agent'),
        tools
      }
    };
  }

  async resolveToolApproval(input: ResolveToolApprovalInput): Promise<AgentResult> {
    return this.toolLoop.resolveToolApproval(input);
  }

  async cancelPendingApprovals(reason?: string): Promise<string[]> {
    return this.toolLoop.cancelPendingApprovals(reason);
  }

  async interruptPendingToolApproval(
    runId: string,
    reason?: string
  ): Promise<AgentResult | undefined> {
    return this.toolLoop.interruptPendingApproval(runId, reason);
  }

  resolveToolApprovalStreaming(
    input: ResolveToolApprovalInput
  ): AsyncIterable<AgentRunStreamEvent> {
    return this.toolLoop.resolveToolApprovalStreaming(input);
  }

  private async attachArtifacts(result: AgentResult): Promise<AgentResult> {
    let events: TraceEvent[] = [];
    try {
      events = await this.options.traceStore.readRun(result.runId);
    } catch {
      // Trace-derived artifacts are best-effort; explicit result data is kept.
    }
    const artifacts = [
      ...new Set([
        ...result.report.artifacts,
        ...extractChangedFilesFromEvents(events)
      ])
    ].sort();
    return agentResultSchema.parse({
      ...result,
      report: {
        ...result.report,
        artifacts
      }
    });
  }

  private async assessRunCompletionGate(
    runId: string,
    originalUserInput: string
  ) {
    let events: TraceEvent[] = [];
    let traceReadable = true;
    try {
      events = await this.options.traceStore.readRun(runId);
    } catch {
      traceReadable = false;
    }
    return this.completionPolicy.assess({
      runId,
      originalUserInput,
      events,
      traceReadable
    });
  }

  private async observeToolCall(input: {
    runId: string;
    call: LlmToolCall;
    tools: ToolMetadata[];
    iteration: number;
  }): Promise<void> {
    const metadata = input.tools.find((tool) => tool.name === input.call.name);
    const classified = classifyToolCallPhase(input.call, metadata);
    await this.setRunPhase(input.runId, classified.phase, {
      trigger: 'tool-call',
      toolName: input.call.name,
      iteration: input.iteration
    });
  }

  private async setRunPhase(
    runId: string,
    phase: RunPhase,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const previous = this.runPhases.get(runId);
    if (previous === phase) {
      return;
    }
    this.runPhases.set(runId, phase);
    await this.appendTraceEvent(runId, 'run.phase.changed', {
      ...details,
      phase,
      previous
    });
  }

  private async completeInterruptedRun(input: {
    runId: string;
    reason: string;
    stage: CancellationStage | 'startup';
  }): Promise<AgentResult> {
    if (this.sessionContext.getThread().getOpenTurnId()) {
      this.sessionContext.interruptTurn('用户中断了当前任务');
    }
    const cancelled = await this.attachArtifacts(
      agentResultSchema.parse({
        runId: input.runId,
        status: 'cancelled',
        cancellationReason: 'user-interrupt',
        summary: '已中断当前任务',
        report: {
          artifacts: [],
          evidence: [`用户在 ${input.stage} 阶段中断运行`],
          incompleteItems: []
        }
      })
    );
    await this.record(input.runId, 'run.interrupted', {
      reason: input.reason,
      stage: input.stage
    });
    await this.record(input.runId, 'run.completed', { ...cancelled });
    return cancelled;
  }

  private async recordContextMaintenance(runId: string): Promise<void> {
    const maintenance = this.sessionContext.getLastMaintenance();
    if (
      !maintenance ||
      (!maintenance.compacted && maintenance.droppedMessageCount === 0)
    ) {
      return;
    }
    await this.record(runId, 'context.compacted', {
      ...maintenance
    });
  }

  private async recordContextMaintenanceEvents(
    runId: string,
    maintenance: ContextMaintenanceResult[]
  ): Promise<void> {
    for (const item of maintenance) {
      if (item.compacted || item.droppedMessageCount > 0) {
        await this.record(runId, 'context.compacted', { ...item });
      }
    }
  }

  private async record(
    runId: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (type === 'run.started') {
      await this.appendTraceEvent(runId, type, payload);
      await this.setRunPhase(runId, 'inspect', { trigger: type });
      return;
    }
    const lifecyclePhase = phaseForLifecycleEvent(type);
    if (lifecyclePhase) {
      await this.setRunPhase(runId, lifecyclePhase, { trigger: type });
    }
    if (type === 'run.completed') {
      await this.setRunPhase(runId, 'complete', {
        trigger: type,
        outcome: payload.status
      });
    }
    await this.appendTraceEvent(runId, type, payload);
    if (type === 'run.completed') {
      this.runPhases.delete(runId);
    }
  }

  private async appendTraceEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const event: TraceEvent = {
      id: `${runId}-${type}-${this.now().getTime()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      runId,
      type,
      timestamp: this.now().toISOString(),
      payload
    };

    await this.options.traceStore.append(event);
  }
}

function summarizeRunUsage(events: TraceEvent[]): RunUsage | undefined {
  const usage: RunUsage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    durationMs: 0
  };

  for (const event of events) {
    const metrics = asRecord(event.payload.metrics);
    if (typeof metrics?.status !== 'string') continue;
    usage.calls += 1;
    usage.durationMs += asFiniteNumber(metrics.durationMs);
    const callUsage = asRecord(metrics.usage);
    usage.inputTokens += asFiniteNumber(callUsage?.inputTokens);
    usage.outputTokens += asFiniteNumber(callUsage?.outputTokens);
    usage.totalTokens += asFiniteNumber(callUsage?.totalTokens);
    usage.cacheReadTokens += asFiniteNumber(callUsage?.cacheReadTokens);
    usage.cacheWriteTokens += asFiniteNumber(callUsage?.cacheWriteTokens);
    usage.reasoningTokens += asFiniteNumber(callUsage?.reasoningTokens);
    usage.estimatedCostUsd += asFiniteNumber(callUsage?.estimatedCostUsd);
  }

  return usage.calls > 0 ? usage : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
