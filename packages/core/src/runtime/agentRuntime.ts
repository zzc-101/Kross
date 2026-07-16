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
import {
  cycleThinkingEffort,
  DEFAULT_THINKING_EFFORT,
  formatModelEffortLabel,
  type ThinkingEffort
} from '../llm/thinkingEffort';
import type {
  LlmClient
} from '../llm/types';
import { detectMode } from '../modes/modeDetector';
import {
  CONDUCTOR_PLAN_SYSTEM_PROMPT,
  CONDUCTOR_REVIEW_SYSTEM_PROMPT,
  PLAN_BODY_SYSTEM_PROMPT,
  PLAN_INTENT_SYSTEM_PROMPT,
  resolveModeTurn
} from '../modes/modePolicy';
import {
  ToolGateway,
  type ToolMetadata
} from '../tools/toolGateway';
import {
  createApprovalPolicy,
  type PermissionMode
} from '../tools/permissionModes';
import {
  isObservableTraceStore,
  type TraceEventListener
} from '../trace/observableTraceStore';
import { extractChangedFilesFromEvents } from '../workspace/changedFiles';
import {
  formatRegistryForPrompt,
  selectActiveProject
} from '../workspace/projectRegistry';
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
import {
  formatConductorReviewSummary,
  formatConductorTaskPlanSummary,
  parseConductorTaskPlanFromText
} from './conductorOrchestration';
import { RuntimeInspection } from './runtimeInspection';
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
  private permissionMode: PermissionMode = 'default';
  /** Held between plan/conductor gate and /approve execution. */
  private pendingModeExecution:
    | import('./agentRuntimeTypes').PendingModeExecution
    | undefined;

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
      syncTodoContext: () => this.syncTodoContextSource(),
      onContextMaintained: (runId, maintenance) =>
        this.recordContextMaintenanceEvents(runId, maintenance)
    });
    if (this.toolGateway) {
      this.toolGateway.setApprovalPolicy(createApprovalPolicy(this.permissionMode));
    }
    this.syncProjectRegistrySource();
  }

  /** Last plan/conductor execution awaiting /approve (if any). */
  getPendingModeExecution(): PendingModeExecution | undefined {
    return this.pendingModeExecution;
  }

  /** @deprecated use getPendingModeExecution */
  getPendingConductorPlan(): PendingConductorExecution | undefined {
    const pending = this.pendingModeExecution;
    return pending?.kind === 'conductor' ? pending : undefined;
  }

  clearPendingModeExecution(): void {
    this.pendingModeExecution = undefined;
  }

  clearPendingConductorPlan(): void {
    this.clearPendingModeExecution();
  }

  getWorkspaceRoots(): WorkspaceRoots | undefined {
    return this.options.workspaceRoots;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.toolGateway?.setApprovalPolicy(createApprovalPolicy(mode));
  }

  getModelLabel(): string {
    const client = this.options.llmClient;
    return formatModelEffortLabel(
      client?.model,
      client?.thinkingEffort ?? DEFAULT_THINKING_EFFORT
    );
  }

  getThinkingEffort(): ThinkingEffort {
    return (
      this.options.llmClient?.thinkingEffort ?? DEFAULT_THINKING_EFFORT
    );
  }

  setThinkingEffort(effort: ThinkingEffort): void {
    const client = this.options.llmClient;
    if (!client?.setThinkingEffort) {
      throw new Error('当前 LLM 客户端不支持切换思考强度');
    }
    client.setThinkingEffort(effort);
  }

  cycleThinkingEffort(): ThinkingEffort {
    const next = cycleThinkingEffort(this.getThinkingEffort());
    this.setThinkingEffort(next);
    return next;
  }

  getLlmClient(): LlmClient | undefined {
    return this.options.llmClient;
  }

  setLlmClient(client: LlmClient | undefined): void {
    this.options.llmClient = client;
    this.toolLoop.setLlmClient(client);
    this.sessionContext.setLlmClient(client);
  }

  setModel(model: string): void {
    const client = this.options.llmClient;
    if (!client?.setModel) {
      throw new Error('当前 LLM 客户端不支持切换模型');
    }
    client.setModel(model);
  }

  restoreConversation(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): ContextMaintenanceResult {
    const maintenance = this.sessionContext.restoreConversation(messages);
    this.options.llmClient?.clearLastUsage?.();
    this.sessionContext.resetCalibration();
    return maintenance;
  }

  exportContextState(): SessionContextState {
    return this.sessionContext.exportState();
  }

  restoreContextState(state: SessionContextState): boolean {
    this.options.llmClient?.clearLastUsage?.();
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
    return this.options.todoStore;
  }

  syncTodoContextSource(): void {
    const store = this.options.todoStore;
    if (!store) {
      return;
    }
    const text = store.formatForPrompt();
    if (!text) {
      this.sessionContext.removeSource('session-todos');
      return;
    }
    this.sessionContext.addSource({
      id: 'session-todos',
      kind: 'user',
      title: 'Session todos',
      content: text,
      priority: 95,
      pinned: true
    });
  }

  /** Inject workspace roots + optional project registry into SessionContext (public for /add-dir). */
  syncProjectRegistrySource(): void {
    const roots = this.options.workspaceRoots;
    if (roots) {
      this.sessionContext.addSource({
        id: 'workspace-roots',
        kind: 'workspace',
        title: 'Workspace roots',
        content: roots.formatForPrompt(),
        priority: 92,
        pinned: true
      });
    } else {
      this.sessionContext.removeSource('workspace-roots');
    }

    const registry = this.options.projectRegistry;
    if (!registry) {
      this.sessionContext.removeSource('project-registry');
      return;
    }
    const selection = selectActiveProject(registry, {
      activeProjectId: this.options.activeProjectId,
      workspaceRoot: this.options.workspaceRoot
    });
    if (!selection) {
      this.sessionContext.addSource({
        id: 'project-registry',
        kind: 'repo',
        title: 'Project registry',
        content:
          'Project registry is configured but no active project could be selected. ' +
          'Set defaultProjectId or ensure workspace is inside a registered repo path.\n' +
          `Projects: ${Object.keys(registry.projects).join(', ')}`,
        priority: 90,
        pinned: true
      });
      return;
    }
    this.sessionContext.addSource({
      id: 'project-registry',
      kind: 'repo',
      title: 'Project registry',
      content: formatRegistryForPrompt(
        selection,
        this.options.projectRegistryPath
      ),
      priority: 90,
      pinned: true
    });
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
    const client = this.options.llmClient;
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
      pending: this.pendingModeExecution,
      hasLlm: Boolean(this.options.llmClient)
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
          yield* this.runnerPlanGatePhase(input, runId, detection.reason);
          return;

        case 'conductor-gate-flow':
          yield* this.runnerConductorGatePhase(input, runId, detection.reason);
          return;

        case 'conductor-execute':
          yield* this.runnerConductorExecutePhase(
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

  /**
   * Runner 阶段：plan 策略的门控流程（分类 + 流式计划 or agent-loop）。
   * 不是「plan 输出管线」——可见文本仍走 stream / agent-loop。
   */
  private async *runnerPlanGatePhase(
    input: AgentRunInput,
    runId: string,
    reason: string | undefined
  ): AsyncIterable<AgentRunStreamEvent> {
    throwIfAborted(input.signal);

    // 1) 内部短分类（complete 仅 JSON，不展示）
    const intent = await this.classifyPlanIntent(input.input, input.signal);
    await this.record(runId, 'plan.intent', intent);

    // 2) chat → 唯一 agent-loop 管线
    if (intent.kind === 'chat') {
      yield* this.runAgentToolLoop(input, 'plan', runId);
      return;
    }

    // 3) 流式写计划 → 确认门
    const header = '【Plan 模式 · 等待确认】\n\n';
    const footer = '\n\n输入 /approve 按该计划开始开发，或 /reject 取消。';
    yield { type: 'text-delta', text: header };

    let planBody = '';
    for await (const event of this.streamPlainAssistantText({
      systemPrompt: PLAN_BODY_SYSTEM_PROMPT,
      userText: input.input,
      signal: input.signal,
      purpose: 'plan-body'
    })) {
      planBody += event.text;
      yield event;
    }

    if (!planBody.trim()) {
      planBody = [
        `目标：${input.input}`,
        '',
        '1. 探索相关代码',
        '2. 实现变更',
        '3. 验证测试'
      ].join('\n');
      yield { type: 'text-delta', text: planBody };
    }

    yield { type: 'text-delta', text: footer };
    yield* this.finishPlanGateWithText(input, runId, planBody.trim(), reason);
  }

  /** 内部 complete：只解析 kind，禁止当用户回复展示。 */
  private async classifyPlanIntent(
    userInput: string,
    signal?: AbortSignal
  ): Promise<{ kind: 'chat' | 'plan'; reason: string }> {
    const client = this.options.llmClient;
    if (!client) {
      return isCasualChatInput(userInput)
        ? { kind: 'chat', reason: 'no-llm heuristic' }
        : { kind: 'plan', reason: 'no-llm heuristic' };
    }
    throwIfAborted(signal);
    try {
      const response = await client.complete({
        messages: [
          { role: 'system', content: PLAN_INTENT_SYSTEM_PROMPT },
          { role: 'user', content: userInput }
        ],
        maxTokens: 80,
        metadata: { purpose: 'plan-mode-intent', internal: true }
      });
      const kind = parsePlanIntentKind(response.text ?? '');
      if (kind) {
        return kind;
      }
    } catch {
      // fall through
    }
    return isCasualChatInput(userInput)
      ? { kind: 'chat', reason: 'llm-failed heuristic' }
      : { kind: 'plan', reason: 'llm-failed heuristic' };
  }

  /** 统一流式助手文本原语（用户可见）。 */
  private async *streamPlainAssistantText(input: {
    systemPrompt: string;
    userText: string;
    signal?: AbortSignal;
    purpose?: string;
  }): AsyncIterable<Extract<AgentRunStreamEvent, { type: 'text-delta' }>> {
    const client = this.options.llmClient;
    if (!client) {
      return;
    }
    throwIfAborted(input.signal);
    for await (const chunk of client.stream({
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userText }
      ],
      signal: input.signal,
      metadata: { purpose: input.purpose ?? 'assistant-stream' }
    })) {
      throwIfAborted(input.signal);
      if (chunk.type === 'text-delta' && chunk.text) {
        yield { type: 'text-delta', text: chunk.text };
      }
    }
  }

  private async *finishPlanGateWithText(
    input: AgentRunInput,
    runId: string,
    planText: string,
    reason: string | undefined
  ): AsyncIterable<AgentRunStreamEvent> {
    await this.record(runId, 'plan.created', {
      mode: 'plan',
      goal: input.input,
      planText
    });
    await this.record(runId, 'approval.required', {
      scope: 'plan-mode',
      reason
    });

    const summary = [
      '【Plan 模式 · 等待确认】',
      '',
      planText,
      '',
      '输入 /approve 按该计划开始开发，或 /reject 取消。'
    ].join('\n');

    this.pendingModeExecution = {
      kind: 'plan',
      goal: input.input,
      mode: 'plan',
      planText
    };

    const cancelled = await this.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode: 'plan',
        status: 'cancelled',
        cancellationReason: 'approval-gate',
        summary,
        report: {
          changedFiles: [],
          evidence: ['plan-first：确认前不改文件'],
          risks: []
        }
      })
    );
    await this.record(runId, 'run.completed', { ...cancelled });
    this.finishTurnWithAssistant(input.input, cancelled.summary);
    yield { type: 'result', result: cancelled };
  }

  /**
   * Runner 阶段：指挥家策略 — 内部拿任务 JSON，流式展示给人看的计划，再确认门。
   */
  private async *runnerConductorGatePhase(
    input: AgentRunInput,
    runId: string,
    conductorReason: string | undefined
  ): AsyncIterable<AgentRunStreamEvent> {
    throwIfAborted(input.signal);
    this.syncProjectRegistrySource();

    const plan = await this.buildConductorTaskPlan(input.input, input.signal);
    const summary = formatConductorTaskPlanSummary(plan);
    // 用户可见：流式吐出格式化计划（非 complete 直出）
    yield { type: 'text-delta', text: summary };

    await this.record(runId, 'plan.created', {
      mode: 'conductor',
      goal: plan.goal,
      tasks: plan.tasks,
      notes: plan.notes
    });
    await this.record(runId, 'approval.required', {
      scope: 'conductor-plan',
      reason: conductorReason,
      taskIds: plan.tasks.map((t) => t.id)
    });

    this.pendingModeExecution = {
      kind: 'conductor',
      goal: input.input,
      mode: 'conductor',
      plan
    };

    const cancelled = await this.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode: 'conductor',
        status: 'cancelled',
        cancellationReason: 'approval-gate',
        summary,
        report: {
          changedFiles: [],
          evidence: [
            `tasks=${plan.tasks.map((t) => t.id).join(',')}`,
            '指挥家策略：高级模型规划 → worker 执行 → 高级模型验收',
            '多目录是 /add-dir，与 mode 正交'
          ],
          risks: []
        }
      })
    );
    await this.record(runId, 'run.completed', { ...cancelled });
    this.finishTurnWithAssistant(input.input, cancelled.summary);
    yield { type: 'result', result: cancelled };
  }

  /** 内部 complete：任务 JSON（不可直接当 chat 展示；展示用 format 后 stream）。 */
  private async buildConductorTaskPlan(
    goal: string,
    signal?: AbortSignal
  ): Promise<import('./conductorOrchestration').ConductorTaskPlan> {
    const client = this.options.llmClient;
    if (!client) {
      return parseConductorTaskPlanFromText(goal, '');
    }
    throwIfAborted(signal);
    const rootsHint = this.options.workspaceRoots
      ? this.options.workspaceRoots.formatForPrompt()
      : '（仅主工作区；可用 /add-dir 增加目录，并在任务里填 repoId）';
    try {
      const response = await client.complete({
        messages: [
          { role: 'system', content: CONDUCTOR_PLAN_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `目标：\n${goal}\n\n当前工作区 roots：\n${rootsHint}`
          }
        ],
        metadata: { purpose: 'conductor-plan', internal: true }
      });
      return parseConductorTaskPlanFromText(goal, response.text ?? '');
    } catch {
      return parseConductorTaskPlanFromText(goal, '');
    }
  }

  /**
   * Runner 阶段：指挥家执行 — worker 子代理 + 流式验收。
   */
  private async *runnerConductorExecutePhase(
    runId: string,
    pending: PendingConductorExecution,
    signal?: AbortSignal
  ): AsyncIterable<AgentRunStreamEvent> {
    throwIfAborted(signal);
    const { plan, goal } = pending;
    const mode = 'conductor' as const;

    await this.record(runId, 'conductor.execution.started', {
      taskIds: plan.tasks.map((t) => t.id),
      workerModel: this.options.workerLlmClient?.model,
      seniorModel: this.options.llmClient?.model
    });

    const runSubagent = this.options.runSubagent;
    if (!runSubagent) {
      const msg =
        '指挥家计划已确认，但运行时未注入 runSubagent，无法派生 worker 子代理。';
      yield { type: 'text-delta', text: msg };
      const failed = await this.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode,
          status: 'failed',
          summary: msg,
          report: {
            changedFiles: [],
            evidence: ['缺少 AgentRuntimeOptions.runSubagent'],
            risks: []
          }
        })
      );
      await this.record(runId, 'run.completed', { ...failed });
      this.pendingModeExecution = undefined;
      this.finishTurnWithAssistant(goal, failed.summary);
      yield { type: 'result', result: failed };
      return;
    }

    const roots = this.options.workspaceRoots;
    const taskOutcomes: Array<{
      taskId: string;
      title: string;
      status: string;
      summary: string;
      changedFiles: string[];
      risks: string[];
    }> = [];
    const allChanged: string[] = [];
    const allEvidence: string[] = [];
    const allRisks: string[] = [];

    for (const task of plan.tasks) {
      throwIfAborted(signal);
      yield {
        type: 'text-delta',
        text: `\n\n▸ Worker 执行任务 [${task.id}] ${task.title}…\n`
      };
      const workspaceRoot = task.repoId
        ? roots?.resolveById(task.repoId)
        : undefined;
      try {
        const outcome = await runSubagent({
          prompt: task.prompt,
          title: task.title.slice(0, 48),
          mode: 'general',
          parentRunId: runId,
          parentDepth: 0,
          signal,
          repoId: task.repoId,
          workspaceRoot,
          preferWorkerModel: true
        });
        const result = outcome.result;
        taskOutcomes.push({
          taskId: task.id,
          title: task.title,
          status: result.status,
          summary: result.summary,
          changedFiles: result.changedFiles,
          risks: result.risks
        });
        yield {
          type: 'text-delta',
          text: `  → ${result.status}: ${result.summary.slice(0, 300)}\n`
        };
        for (const file of result.changedFiles) {
          allChanged.push(`${task.id}:${file}`);
        }
        allEvidence.push(
          `${task.id}: ${result.status} — ${result.summary.slice(0, 200)}`
        );
        allRisks.push(...result.risks.map((r) => `${task.id}: ${r}`));
      } catch (error) {
        if (isOperationAborted(error, signal)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        taskOutcomes.push({
          taskId: task.id,
          title: task.title,
          status: 'failed',
          summary: message,
          changedFiles: [],
          risks: [message]
        });
        yield { type: 'text-delta', text: `  → failed: ${message}\n` };
        allEvidence.push(`${task.id}: failed — ${message}`);
        allRisks.push(`${task.id}: ${message}`);
      }
    }

    yield { type: 'text-delta', text: '\n### 高级模型验收\n\n' };
    const digest = taskOutcomes
      .map(
        (o) =>
          `### ${o.taskId} ${o.title} [${o.status}]\n${o.summary}\nfiles=${o.changedFiles.join(', ') || '—'}\nrisks=${o.risks.join('; ') || '—'}`
      )
      .join('\n\n');

    let reviewText = '';
    if (this.options.llmClient) {
      for await (const event of this.streamPlainAssistantText({
        systemPrompt: CONDUCTOR_REVIEW_SYSTEM_PROMPT,
        userText: `总目标：\n${goal}\n\nWorker 结果：\n${digest}`,
        signal,
        purpose: 'conductor-review'
      })) {
        reviewText += event.text;
        yield event;
      }
    }
    if (!reviewText.trim()) {
      reviewText = [
        '（无高级模型流式验收）',
        `共 ${taskOutcomes.length} 个子任务，失败 ${taskOutcomes.filter((o) => o.status === 'failed').length} 个。`
      ].join('\n');
      yield { type: 'text-delta', text: reviewText };
    }

    await this.record(runId, 'conductor.review.completed', {
      taskCount: taskOutcomes.length,
      reviewPreview: reviewText.slice(0, 400)
    });

    const summary = formatConductorReviewSummary({
      goal,
      taskOutcomes,
      reviewText
    });
    const anyFailed = taskOutcomes.some((o) => o.status === 'failed');

    const result = await this.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode,
        status: anyFailed ? 'failed' : 'completed',
        summary,
        report: {
          changedFiles: allChanged,
          evidence: [
            `senior=${this.options.llmClient?.model ?? 'n/a'}`,
            `worker=${this.options.workerLlmClient?.model ?? this.options.llmClient?.model ?? 'n/a'}`,
            ...allEvidence
          ],
          risks: allRisks
        }
      })
    );

    await this.record(runId, 'review.completed', {
      status: result.status,
      summary: result.summary,
      tasks: taskOutcomes.map((o) => ({ id: o.taskId, status: o.status }))
    });
    await this.record(runId, 'run.completed', { ...result });
    this.pendingModeExecution = undefined;
    this.finishTurnWithAssistant(goal, result.summary);
    yield { type: 'result', result };
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
    this.syncTodoContextSource();
    this.syncProjectRegistrySource();
    return {
      buildContextInput: {
        systemPrompt: PLANNER_SYSTEM_PROMPT,
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
    this.syncTodoContextSource();
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

/** 无模型时的轻量兜底；主路径由 decidePlanModeIntent 的 LLM 判断。 */
export function isCasualChatInput(input: string): boolean {
  const text = input.trim();
  if (text.length === 0) {
    return true;
  }
  if (text.length > 40) {
    return false;
  }
  return /^(你好|您好|嗨|哈喽|在吗|在不在|早上好|中午好|下午好|晚上好|谢谢|感谢|再见|拜拜|ok|okay|好的|嗯|hi|hello|hey|thanks|thank you|bye)([\s!！.。?？~～❤️🙏]*)$/i.test(
    text
  );
}

/** 解析 plan 意图分类 JSON（仅 kind，不承载展示正文）。 */
export function parsePlanIntentKind(
  raw: string
): { kind: 'chat' | 'plan'; reason: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    const kind = typeof obj.kind === 'string' ? obj.kind.toLowerCase() : '';
    const reason =
      typeof obj.reason === 'string' && obj.reason.trim()
        ? obj.reason.trim()
        : 'model';
    if (kind === 'chat' || kind === 'plan') {
      return { kind, reason };
    }
  } catch {
    // fall through
  }
  if (/\bkind\b["']?\s*[:=]\s*["']?chat/i.test(trimmed)) {
    return { kind: 'chat', reason: 'regex' };
  }
  if (/\bkind\b["']?\s*[:=]\s*["']?plan/i.test(trimmed)) {
    return { kind: 'plan', reason: 'regex' };
  }
  return undefined;
}


