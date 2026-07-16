import { EventEmitter } from 'node:events';

import {
  abortMessage,
  isOperationAborted,
  throwIfAborted
} from '../abort';
import {
  type AgentMode,
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
import type { LlmClient } from '../llm/types';
import { detectMode } from '../modes/modeDetector';
import { resolveModeTurn } from '../modes/modePolicy';
import {
  ToolGateway,
  type ToolMetadata
} from '../tools/toolGateway';
import { createSetModeTool } from '../tools/builtin/setMode';
import type { PermissionMode } from '../tools/permissionModes';
import {
  isObservableTraceStore,
  type TraceEventListener
} from '../trace/observableTraceStore';
import { extractChangedFilesFromEvents } from '../workspace/changedFiles';
import type { ProjectInstructionsSnapshot } from '../workspace/projectInstructions';
import type { SkillsSnapshot } from '../skills/skillDiscovery';
import type { MutationRecord } from '../mutations/mutationJournal';
import type { UndoResult } from '../mutations/mutationService';
import { WorkspaceRoots } from '../workspace/workspaceRoots';
import type { ListRunsOptions } from '../trace/traceStore';
import type { RunTraceDetail, RunTraceSummary } from '../trace/traceSummary';
import type {
  AgentRunInput,
  AgentRunStreamEvent,
  AgentRuntimeOptions,
  ContextInspection,
  ContextInspectionInput,
  PendingConductorExecution,
  PendingModeExecution,
  ResolveToolApprovalInput
} from './agentRuntimeTypes';
import { RuntimeInspection } from './runtimeInspection';
import { ModelSession } from './modelSession';
import { ModeFlows } from './modeFlows';
import { SessionServices } from './sessionServices';
import {
  DEFAULT_MAX_TOOL_ITERATIONS,
  PLANNER_SYSTEM_PROMPT,
  RuntimeToolLoop
} from './toolLoop';
import type { CancellationStage } from './streamingToolLoop';

export { DEFAULT_MAX_TOOL_ITERATIONS } from './toolLoop';

export type {
  AgentRunInput,
  AgentRunStreamEvent,
  AgentRuntimeEvent,
  AgentRuntimeOptions,
  ContextInspection,
  ContextInspectionInput,
  ResolveToolApprovalInput
} from './agentRuntimeTypes';

export type { ContextMaintenanceResult } from '../context/sessionContext';
export {
  chunkTextForStream,
  isCasualChatInput,
  parsePlanIntentKind
} from './modeFlows';

/**
 * 工具调用轮次安全上限（默认）。
 * 一轮 = 模型发 tool_calls → 执行 → 回填再问模型。
 */
export class AgentRuntime extends EventEmitter {
  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly sessionContext: SessionContext;
  private readonly toolGateway: ToolGateway | undefined;
  private readonly inspection: RuntimeInspection;
  private readonly toolLoop: RuntimeToolLoop;
  private readonly modelSession: ModelSession;
  private readonly modeFlows: ModeFlows;
  private readonly sessionServices: SessionServices;

  constructor(private readonly options: AgentRuntimeOptions) {
    super();
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
    this.inspection = new RuntimeInspection(options);
    this.toolLoop = new RuntimeToolLoop({
      llmClient: options.llmClient,
      toolGateway: this.toolGateway,
      sessionContext: this.sessionContext,
      maxToolIterations: options.maxToolIterations,
      record: (runId, type, payload) => this.record(runId, type, payload),
      attachChangedFiles: (result) => this.attachChangedFiles(result),
      commitTurn: () => this.sessionContext.commitTurn(),
      abortTurn: (reason) => this.sessionContext.abortTurn(reason),
      interruptTurn: (reason) => this.sessionContext.interruptTurn(reason),
      appendAssistantForCancel: (summary) =>
        this.sessionContext.appendAssistant(summary),
      syncTodoContext: () => this.sessionServices.syncTodoContextSource(),
      onContextMaintained: (runId, maintenance) =>
        this.recordContextMaintenanceEvents(runId, maintenance)
    });
    this.modelSession = new ModelSession(this.options, (client) => {
      this.toolLoop.setLlmClient(client);
      this.sessionContext.setLlmClient(client);
    });
    this.sessionServices = new SessionServices({
      options: this.options,
      sessionContext: this.sessionContext,
      toolGateway: this.toolGateway,
      emitModeChanged: (event) => this.emit('mode.changed', event)
    });
    this.modeFlows = new ModeFlows({
      options: this.options,
      modelSession: this.modelSession,
      sessionServices: this.sessionServices,
      record: (runId, type, payload) => this.record(runId, type, payload),
      runAgentToolLoop: (input, mode, runId, flowOptions) =>
        this.runAgentToolLoop(input, mode, runId, flowOptions),
      attachChangedFiles: (result) => this.attachChangedFiles(result),
      finishTurnWithAssistant: (userInput, assistantOutput) =>
        this.finishTurnWithAssistant(userInput, assistantOutput)
    });
    if (this.toolGateway) {
      // SetMode 挂在 runtime 上，保证 get/set 与会话状态一致
      if (!this.toolGateway.listTools().some((t) => t.name === 'SetMode')) {
        this.toolGateway.register(
          createSetModeTool({
            getMode: () => this.getSessionMode(),
            setMode: (mode) => this.setSessionMode(mode)
          })
        );
      }
    }
    this.sessionServices.syncProjectRegistrySource();
    this.sessionServices.refreshProjectInstructions();
    this.sessionServices.refreshSkills();
    this.sessionServices.syncSessionModeSource();
  }

  getSessionMode(): AgentMode {
    return this.sessionServices.getSessionMode();
  }

  /**
   * 更新会话 Mode（策略）。同步 context source 并 emit `mode.changed` 供 TUI 刷新。
   */
  setSessionMode(mode: AgentMode): void {
    this.sessionServices.setSessionMode(mode);
  }

  /** 订阅会话 Mode 变更（TUI 用于刷新页脚）。 */
  onModeChanged(
    listener: (event: { mode: AgentMode; previous: AgentMode }) => void
  ): () => void {
    this.on('mode.changed', listener);
    return () => {
      this.off('mode.changed', listener);
    };
  }

  /** Last plan/conductor execution awaiting /approve (if any). */
  getPendingModeExecution(): PendingModeExecution | undefined {
    return this.sessionServices.getPendingModeExecution();
  }

  /** @deprecated use getPendingModeExecution */
  getPendingConductorPlan(): PendingConductorExecution | undefined {
    return this.sessionServices.getPendingConductorPlan();
  }

  clearPendingModeExecution(): void {
    this.sessionServices.clearPendingModeExecution();
  }

  clearPendingConductorPlan(): void {
    this.clearPendingModeExecution();
  }

  getWorkspaceRoots(): WorkspaceRoots | undefined {
    return this.sessionServices.getWorkspaceRoots();
  }

  getPermissionMode(): PermissionMode {
    return this.sessionServices.getPermissionMode();
  }

  setPermissionMode(mode: PermissionMode): void {
    this.sessionServices.setPermissionMode(mode);
  }

  getModelLabel(): string {
    return this.modelSession.getModelLabel();
  }

  getThinkingEffort(): ThinkingEffort {
    return this.modelSession.getThinkingEffort();
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

  restoreContextState(state: SessionContextState): boolean {
    this.modelSession.getLlmClient()?.clearLastUsage?.();
    this.sessionContext.resetCalibration();
    return this.sessionContext.restoreState(state);
  }

  getLastContextMaintenance(): ContextMaintenanceResult | undefined {
    return this.sessionContext.getLastMaintenance();
  }

  getAllContextMaintenance(): ContextMaintenanceResult[] {
    return this.sessionContext.getAllMaintenance();
  }

  getPreserveFullTurns(): number {
    return this.sessionContext.getPolicy().preserveFullTurns;
  }

  async compactNow(
    input: ContextInspectionInput = { requestedMode: 'auto' },
    instructions?: string,
    signal?: AbortSignal
  ): Promise<ContextMaintenanceResult> {
    const { buildContextInput } = this.resolveContextBuildInput(input);
    return this.sessionContext.compactNow(
      buildContextInput,
      instructions,
      signal
    );
  }

  getTodoStore(): import('../todo/todoStore').TodoStore | undefined {
    return this.sessionServices.getTodoStore();
  }

  syncTodoContextSource(): void {
    this.sessionServices.syncTodoContextSource();
  }

  /** Inject workspace roots + optional project registry into SessionContext (public for /add-dir). */
  syncProjectRegistrySource(): void {
    this.sessionServices.syncProjectRegistrySource();
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

  listMutations(): MutationRecord[] {
    const coordinator = this.options.mutationCoordinator;
    if (!coordinator) return [];
    const roots = this.options.workspaceRoots?.list() ??
      (this.options.workspaceRoot
        ? [{ path: this.options.workspaceRoot }]
        : []);
    return roots.flatMap((root) => coordinator.forWorkspace(root.path).listActive());
  }

  undoMutation(target?: string): UndoResult {
    const coordinator = this.options.mutationCoordinator;
    if (!coordinator) throw new Error('Mutation journal is not configured');
    return coordinator.undo(target);
  }

  getContextUsage(input: {
    requestedMode: AgentMode;
    currentUserInput?: string;
    env?: Record<string, string | undefined>;
  }): {
    usedChars: number;
    usedTokens: number;
    maxTokens: number;
    compactThreshold: number;
    lastUsageTokens?: number;
    label: string;
    ratio: number;
    headerLabel: string;
    headerRatio: number;
  } {
    const snapshot = this.inspectContext({
      requestedMode: input.requestedMode,
      currentUserInput: input.currentUserInput
    });
    const client = this.modelSession.getLlmClient();
    const lastUsageTokens = client?.lastUsage?.inputTokens;
    const usedTokens = snapshot.estimatedTokens;
    const maxTokens = snapshot.inputBudget;
    const compactThreshold = snapshot.compactThreshold;
    const headerTokens = lastUsageTokens ?? 0;
    const contextWindow = this.sessionContext.getPolicy().contextWindow;
    return {
      usedChars: snapshot.estimatedChars,
      usedTokens,
      maxTokens,
      compactThreshold,
      lastUsageTokens,
      label: formatContextUsage(usedTokens, maxTokens),
      ratio: usedTokens / Math.max(1, compactThreshold),
      headerLabel: formatContextUsage(headerTokens, contextWindow),
      headerRatio: headerTokens / Math.max(1, contextWindow)
    };
  }

  onTrace(listener: TraceEventListener): () => void {
    if (isObservableTraceStore(this.options.traceStore)) {
      return this.options.traceStore.subscribe(listener);
    }

    if (this.toolGateway) {
      console.warn(
        '[AgentRuntime.onTrace] traceStore is not ObservableTraceStore; ' +
          'tool_call events from ToolGateway will not be delivered. ' +
          'Wrap the store with ObservableTraceStore for TUI tool cards.'
      );
    }

    const handler = (event: TraceEvent) => listener(event);
    this.on('event', handler);
    return () => {
      this.off('event', handler);
    };
  }

  async listTraces(options: ListRunsOptions = {}): Promise<RunTraceSummary[]> {
    return this.inspection.listTraces(options);
  }

  async inspectTrace(runId: string): Promise<RunTraceDetail | null> {
    return this.inspection.inspectTrace(runId);
  }

  async formatTraceCommand(argument?: string): Promise<string> {
    return this.inspection.formatTraceCommand(argument);
  }

  async formatDiffCommand(argument?: string): Promise<string> {
    return this.inspection.formatDiffCommand(argument);
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

  /**
   * 统一 Runner：mode 只通过 ModePolicy 决定动作，输出管线唯一。
   * 用户可见文本只允许 text-delta / thinking-delta。
   */
  private async *executeRun(
    input: AgentRunInput
  ): AsyncIterable<AgentRunStreamEvent> {
    const { detection, action } = resolveModeTurn({
      requestedMode: input.requestedMode,
      userInput: input.input,
      planApproved: input.approvals?.plan === true,
      pending: this.sessionServices.getPendingModeExecution(),
      hasLlm: Boolean(this.modelSession.getLlmClient())
    });
    const runId = this.createRunId();

    try {
      await this.record(runId, 'run.started', { input: input.input });
      throwIfAborted(input.signal);
      await this.record(runId, 'planner.started', {
        requestedMode: input.requestedMode
      });
      await this.record(runId, 'mode.detected', {
        ...detection,
        action: action.type
      });
      throwIfAborted(input.signal);

      switch (action.type) {
        case 'agent-loop':
          yield* this.runAgentToolLoop(input, action.mode, runId, {
            planText: action.planText
          });
          return;

        case 'plan-gate-flow':
          yield* this.modeFlows.planGatePhase(input, runId, detection.reason);
          return;

        case 'conductor-gate-flow':
          yield* this.modeFlows.conductorGatePhase(
            input,
            runId,
            detection.reason
          );
          return;

        case 'conductor-execute':
          yield* this.modeFlows.conductorExecutePhase(
            runId,
            action.pending,
            input.signal
          );
          return;

        case 'no-llm': {
          const result = await this.finishRunWithoutLlm(
            input,
            action.mode,
            runId,
            detection.reason
          );
          yield { type: 'result', result };
          return;
        }

        default: {
          const _exhaustive: never = action;
          void _exhaustive;
          yield* this.runAgentToolLoop(input, 'auto', runId);
        }
      }
    } catch (error) {
      if (!isOperationAborted(error, input.signal)) {
        throw error;
      }
      const cancelled = await this.completeInterruptedRun({
        runId,
        mode: detection.mode,
        reason: abortMessage(input.signal),
        stage: 'startup'
      });
      yield { type: 'result', result: cancelled };
    }
  }

  private async *runAgentToolLoop(
    input: AgentRunInput,
    mode: AgentMode,
    runId: string,
    options: { planText?: string } = {}
  ): AsyncIterable<AgentRunStreamEvent> {
    throwIfAborted(input.signal);
    this.sessionContext.beginTurn(input.input);
    if (options.planText?.trim()) {
      this.sessionContext.addSource({
        id: 'approved-plan',
        kind: 'user',
        title: 'Approved plan',
        content: options.planText.trim(),
        priority: 96,
        pinned: true
      });
    } else {
      this.sessionContext.removeSource('approved-plan');
    }
    const { buildContextInput, tools } = this.buildPlannerContext(mode);
    const prepared = await this.sessionContext.prepareRequest(
      buildContextInput,
      input.signal
    );
    throwIfAborted(input.signal);
    await this.recordPlannerContext(runId, prepared);

    yield* this.toolLoop.runStreamingToolLoop({
      runId,
      mode,
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
          const result = await this.attachChangedFiles(
            agentResultSchema.parse({
              runId,
              mode,
              status: 'completed',
              summary: fullText,
              report: {
                changedFiles: [],
                evidence: [],
                risks: []
              }
            })
          );
          await this.record(runId, 'run.completed', { ...result });
          this.sessionContext.commitTurn();
          return result;
        },
        onSoftLand: async ({ summary }) => {
          this.sessionContext.appendAssistant(summary);
          const landed = await this.attachChangedFiles(
            agentResultSchema.parse({
              runId,
              mode,
              status: 'completed',
              summary,
              report: {
                changedFiles: [],
                evidence: [
                  `工具调用达到上限 ${this.options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS} 轮，已软着陆为总结`
                ],
                risks: ['部分计划可能未执行完，可继续对话推进']
              }
            })
          );
          await this.record(runId, 'run.completed', { ...landed });
          this.sessionContext.commitTurn();
          return landed;
        },
        onFailure: async (message) => {
          const failed = await this.attachChangedFiles(
            agentResultSchema.parse({
              runId,
              mode,
              status: 'failed',
              summary: `模型请求失败：${message}`,
              report: {
                changedFiles: [],
                evidence: [`LLM 请求失败: ${message}`],
                risks: ['请检查模型名称、baseUrl、鉴权方式或网络连通性']
              }
            })
          );
          await this.record(runId, 'run.completed', { ...failed });
          this.sessionContext.abortTurn(message);
          return failed;
        },
        onCancelled: async ({ reason, stage }) =>
          this.completeInterruptedRun({ runId, mode, reason, stage })
      }
    });
  }

  private async finishRunWithoutLlm(
    input: AgentRunInput,
    mode: AgentMode,
    runId: string,
    _conductorReason: string | undefined
  ): Promise<AgentResult> {
    const missingModel = await this.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode,
        status: 'failed',
        summary:
          '未配置模型，无法生成真实回复。请配置 AGENT_LLM_PROVIDER 以及对应的 OPENAI_* 或 ANTHROPIC_* 环境变量后重试。',
        report: {
          changedFiles: [],
          evidence: ['未检测到可用 LLM client'],
          risks: []
        }
      })
    );

    await this.record(runId, 'run.completed', { ...missingModel });
    return missingModel;
  }

  private finishTurnWithAssistant(userInput: string, assistantOutput: string): void {
    if (!this.sessionContext.getThread().getOpenTurnId()) {
      this.sessionContext.beginTurn(userInput);
    }
    this.sessionContext.appendAssistant(assistantOutput);
    this.sessionContext.commitTurn();
  }

  private buildPlannerContext(mode: AgentMode): {
    buildContextInput: {
      systemPrompt: string;
      mode: AgentMode;
      tools: ToolMetadata[];
    };
    tools: ToolMetadata[];
  } {
    const tools = this.toolGateway?.listTools({ mode }) ?? [];
    this.sessionServices.syncTodoContextSource();
    this.sessionServices.syncProjectRegistrySource();
    this.sessionServices.refreshProjectInstructions();
    this.sessionServices.refreshSkills();
    this.sessionServices.syncSessionModeSource();
    return {
      buildContextInput: {
        systemPrompt: `${PLANNER_SYSTEM_PROMPT}\n会话 Mode：${this.sessionServices.getSessionMode()}；本轮策略：${mode}。`,
        mode,
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

  inspectContext(input: ContextInspectionInput): ContextInspection {
    const { mode, buildContextInput } = this.resolveContextBuildInput(input);
    const snapshot = this.sessionContext.snapshot(buildContextInput);

    return {
      ...snapshot,
      mode
    };
  }

  private resolveContextBuildInput(input: ContextInspectionInput): {
    mode: AgentMode;
    buildContextInput: {
      systemPrompt: string;
      mode: AgentMode;
      tools: ToolMetadata[];
    };
  } {
    const mode =
      input.requestedMode === 'auto'
        ? input.currentUserInput?.trim()
          ? detectMode({
              requestedMode: input.requestedMode,
              input: input.currentUserInput ?? ''
            }).mode
          : 'auto'
        : input.requestedMode;
    this.sessionServices.syncTodoContextSource();
    this.sessionServices.refreshProjectInstructions();
    this.sessionServices.refreshSkills();
    const tools = this.toolGateway?.listTools({ mode }) ?? [];
    return {
      mode,
      buildContextInput: {
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        mode,
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

  private async attachChangedFiles(result: AgentResult): Promise<AgentResult> {
    let events: TraceEvent[] = [];
    try {
      events = await this.options.traceStore.readRun(result.runId);
    } catch {
      return result;
    }
    const changedFiles = extractChangedFilesFromEvents(events);
    if (
      changedFiles.length === result.report.changedFiles.length &&
      changedFiles.every((path, index) => path === result.report.changedFiles[index])
    ) {
      return result;
    }

    return agentResultSchema.parse({
      ...result,
      report: {
        ...result.report,
        changedFiles
      }
    });
  }

  private async completeInterruptedRun(input: {
    runId: string;
    mode: AgentMode;
    reason: string;
    stage: CancellationStage | 'startup';
  }): Promise<AgentResult> {
    if (this.sessionContext.getThread().getOpenTurnId()) {
      this.sessionContext.interruptTurn('用户中断了当前任务');
    }
    const cancelled = await this.attachChangedFiles(
      agentResultSchema.parse({
        runId: input.runId,
        mode: input.mode,
        status: 'cancelled',
        cancellationReason: 'user-interrupt',
        summary: '已中断当前任务',
        report: {
          changedFiles: [],
          evidence: [`用户在 ${input.stage} 阶段中断运行`],
          risks: []
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
    this.emit('event', event);
  }
}
