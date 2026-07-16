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
  PendingPlanExecution,
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

  private async *executeRun(
    input: AgentRunInput
  ): AsyncIterable<AgentRunStreamEvent> {
    const detection = detectMode({
      requestedMode: input.requestedMode,
      input: input.input
    });
    const runId = this.createRunId();

    try {
      await this.record(runId, 'run.started', { input: input.input });
      throwIfAborted(input.signal);
      await this.record(runId, 'planner.started', {
        requestedMode: input.requestedMode
      });
      await this.record(runId, 'mode.detected', { ...detection });
      throwIfAborted(input.signal);

      if (detection.mode === 'auto' && this.options.llmClient) {
        yield* this.runAgentToolLoop(input, detection.mode, runId);
        return;
      }

      if (detection.mode === 'plan') {
        if (input.approvals?.plan === true && this.pendingModeExecution?.kind === 'plan') {
          const pending = this.pendingModeExecution;
          this.pendingModeExecution = undefined;
          if (this.options.llmClient) {
            yield* this.runAgentToolLoop(input, 'plan', runId, {
              planText: pending.planText
            });
            return;
          }
        }
        const result = await this.runPlanMode(
          input,
          detection.mode,
          runId,
          detection.reason
        );
        yield { type: 'result', result };
        return;
      }

      if (detection.mode === 'conductor') {
        const result = await this.runConductor(
          input,
          detection.mode,
          runId,
          detection.reason
        );
        yield { type: 'result', result };
        return;
      }

      const result = await this.finishRunWithoutLlm(
        input,
        detection.mode,
        runId,
        detection.reason
      );
      yield { type: 'result', result };
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
   * Plan mode: model judges whether input needs a plan.
   * - chat/Q&A/small-talk → direct reply (no /approve)
   * - real implementation task → plan text → /approve → tool-loop develop
   */
  private async runPlanMode(
    input: AgentRunInput,
    mode: AgentMode,
    runId: string,
    reason: string | undefined
  ): Promise<AgentResult> {
    throwIfAborted(input.signal);

    if (
      input.approvals?.plan === true &&
      this.pendingModeExecution?.kind === 'plan'
    ) {
      const pending = this.pendingModeExecution;
      this.pendingModeExecution = undefined;
      if (!this.options.llmClient) {
        return this.finishRunWithoutLlm(input, mode, runId, reason);
      }
      let result: AgentResult | undefined;
      for await (const event of this.runAgentToolLoop(input, 'plan', runId, {
        planText: pending.planText
      })) {
        if (event.type === 'result') {
          result = event.result;
        }
      }
      if (!result) {
        throw new Error(`Plan execution finished without result: ${runId}`);
      }
      return result;
    }

    const decision = await this.decidePlanModeIntent(input.input, input.signal);
    await this.record(runId, 'plan.intent', {
      kind: decision.kind,
      reason: decision.reason
    });

    if (decision.kind === 'chat') {
      const reply = decision.reply;
      const completed = await this.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode: 'plan',
          status: 'completed',
          summary: reply,
          report: {
            changedFiles: [],
            evidence: [
              'plan 模式：模型判断无需开发计划，直接回复',
              decision.reason
            ],
            risks: []
          }
        })
      );
      await this.record(runId, 'run.completed', { ...completed });
      this.finishTurnWithAssistant(input.input, completed.summary);
      return completed;
    }

    const planText = decision.planText;
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

    if (input.approvals?.plan === true) {
      this.pendingModeExecution = undefined;
      if (!this.options.llmClient) {
        return this.finishRunWithoutLlm(input, mode, runId, reason);
      }
      let result: AgentResult | undefined;
      for await (const event of this.runAgentToolLoop(input, 'plan', runId, {
        planText
      })) {
        if (event.type === 'result') {
          result = event.result;
        }
      }
      if (!result) {
        throw new Error(`Plan execution finished without result: ${runId}`);
      }
      return result;
    }

    const cancelled = await this.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode: 'plan',
        status: 'cancelled',
        cancellationReason: 'approval-gate',
        summary,
        report: {
          changedFiles: [],
          evidence: ['plan-first：模型判断需要计划；确认前不改文件'],
          risks: []
        }
      })
    );
    await this.record(runId, 'run.completed', { ...cancelled });
    this.finishTurnWithAssistant(input.input, cancelled.summary);
    return cancelled;
  }

  /**
   * 由高级模型判断：闲聊/问答直接回复，还是产出开发计划。
   * 无模型时仅用轻量启发式兜底。
   */
  private async decidePlanModeIntent(
    userInput: string,
    signal?: AbortSignal
  ): Promise<
    | { kind: 'chat'; reply: string; reason: string }
    | { kind: 'plan'; planText: string; reason: string }
  > {
    const client = this.options.llmClient;
    if (!client) {
      if (isCasualChatInput(userInput)) {
        return {
          kind: 'chat',
          reply: '你好。当前是 Plan 模式；有具体开发任务时再说，我会先出计划请你确认。',
          reason: 'no-llm + casual heuristic'
        };
      }
      return {
        kind: 'plan',
        planText: [
          `目标：${userInput}`,
          '',
          '建议步骤：',
          '1. 阅读相关代码与测试，确认现状',
          '2. 列出拟修改文件与接口影响',
          '3. 按最小可验证增量实现',
          '4. 跑相关测试并自检'
        ].join('\n'),
        reason: 'no-llm + task fallback template'
      };
    }

    throwIfAborted(signal);
    try {
      const response = await client.complete({
        messages: [
          {
            role: 'system',
            content: [
              '你在 Plan 模式路由层。根据用户输入判断是否需要「开发计划」。',
              '',
              '规则：',
              '- 问候、闲聊、感谢、单纯提问且不要求改代码 → kind=chat，写自然回复。',
              '- 要求写代码/改代码/修 bug/加功能/重构/跑测试并改仓库等 → kind=plan，写可执行开发计划（目标、步骤、涉及文件/模块、风险与验证）。',
              '- 不要调用工具，不要编造已改代码。',
              '',
              '只输出 JSON（可包在 ```json 中）：',
              '{"kind":"chat","reply":"...","reason":"..."}',
              '或',
              '{"kind":"plan","plan":"...","reason":"..."}'
            ].join('\n')
          },
          { role: 'user', content: userInput }
        ],
        metadata: { purpose: 'plan-mode-intent' }
      });
      const parsed = parsePlanModeIntent(userInput, response.text ?? '');
      if (parsed) {
        return parsed;
      }
    } catch {
      // fall through
    }

    // 模型失败时的保守兜底：明显闲聊直回，否则出计划
    if (isCasualChatInput(userInput)) {
      return {
        kind: 'chat',
        reply: '你好。有具体开发任务时发我，我会在 Plan 模式下先出计划再动手。',
        reason: 'llm-failed + casual heuristic'
      };
    }
    return {
      kind: 'plan',
      planText: [
        `目标：${userInput}`,
        '',
        '1. 探索相关代码',
        '2. 实现变更',
        '3. 验证测试'
      ].join('\n'),
      reason: 'llm-failed + task fallback'
    };
  }

  /**
   * Conductor (指挥家): 高级模型拆任务 → 经济/快速 worker 子代理执行 → 高级模型验收。
   * 多目录是 /add-dir 能力，不在此模式绑定。
   */
  private async runConductor(
    input: AgentRunInput,
    mode: AgentMode,
    runId: string,
    conductorReason: string | undefined
  ): Promise<AgentResult> {
    throwIfAborted(input.signal);
    this.syncProjectRegistrySource();

    if (
      input.approvals?.plan === true &&
      this.pendingModeExecution?.kind === 'conductor'
    ) {
      return this.executeConductorPlan(
        runId,
        this.pendingModeExecution,
        input.signal
      );
    }

    return this.planConductor(input, mode, runId, conductorReason);
  }

  private async planConductor(
    input: AgentRunInput,
    mode: AgentMode,
    runId: string,
    conductorReason: string | undefined
  ): Promise<AgentResult> {
    const plan = await this.buildConductorTaskPlan(input.input, input.signal);
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

    const summary = formatConductorTaskPlanSummary(plan);
    this.pendingModeExecution = {
      kind: 'conductor',
      goal: input.input,
      mode: 'conductor',
      plan
    };

    if (input.approvals?.plan === true) {
      return this.executeConductorPlan(
        runId,
        this.pendingModeExecution,
        input.signal
      );
    }

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
            '指挥家：高级模型规划 → 确认后 worker 执行 → 高级模型验收',
            '多目录请用 /add-dir（任意 mode）'
          ],
          risks: []
        }
      })
    );
    await this.record(runId, 'run.completed', { ...cancelled });
    this.finishTurnWithAssistant(input.input, cancelled.summary);
    return cancelled;
  }

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
          {
            role: 'system',
            content:
              '你是指挥家（高级编排模型）。把用户目标拆成可由「经济/快速 worker 子代理」并行或串行执行的任务。\n' +
              '只输出 JSON（可包在 ```json 代码块中），schema:\n' +
              '{"goal":string,"notes"?:string,"tasks":[{"id":string,"title":string,"prompt":string,"repoId"?:string}]}\n' +
              '要求：tasks 至少 1 个；prompt 必须完整可独立执行；repoId 仅当需要绑定 /add-dir 的 root id 时填写。\n' +
              '不要写代码实现，不要调用工具。'
          },
          {
            role: 'user',
            content: `目标：\n${goal}\n\n当前工作区 roots：\n${rootsHint}`
          }
        ],
        metadata: { purpose: 'conductor-plan' }
      });
      return parseConductorTaskPlanFromText(goal, response.text ?? '');
    } catch {
      return parseConductorTaskPlanFromText(goal, '');
    }
  }

  private async executeConductorPlan(
    runId: string,
    pending: PendingConductorExecution,
    signal?: AbortSignal
  ): Promise<AgentResult> {
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
      const failed = await this.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode,
          status: 'failed',
          summary:
            '指挥家计划已确认，但运行时未注入 runSubagent，无法派生 worker 子代理。',
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
      return failed;
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
        allEvidence.push(`${task.id}: failed — ${message}`);
        allRisks.push(`${task.id}: ${message}`);
      }
    }

    const reviewText = await this.reviewConductorOutcomes(
      goal,
      taskOutcomes,
      signal
    );
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
    return result;
  }

  private async reviewConductorOutcomes(
    goal: string,
    outcomes: Array<{
      taskId: string;
      title: string;
      status: string;
      summary: string;
      changedFiles: string[];
      risks: string[];
    }>,
    signal?: AbortSignal
  ): Promise<string> {
    const client = this.options.llmClient;
    const digest = outcomes
      .map(
        (o) =>
          `### ${o.taskId} ${o.title} [${o.status}]\n${o.summary}\nfiles=${o.changedFiles.join(', ') || '—'}\nrisks=${o.risks.join('; ') || '—'}`
      )
      .join('\n\n');
    if (!client) {
      return [
        '（无高级模型，跳过验收 LLM）',
        `共 ${outcomes.length} 个子任务，失败 ${outcomes.filter((o) => o.status === 'failed').length} 个。`,
        '请人工核对 worker 输出。'
      ].join('\n');
    }
    throwIfAborted(signal);
    try {
      const response = await client.complete({
        messages: [
          {
            role: 'system',
            content:
              '你是指挥家高级模型，负责验收 worker 子代理的结果。' +
              '用中文给出：是否达标、遗漏、风险、建议的后续动作。简洁有条理。'
          },
          {
            role: 'user',
            content: `总目标：\n${goal}\n\nWorker 结果：\n${digest}`
          }
        ],
        metadata: { purpose: 'conductor-review' }
      });
      return response.text?.trim() || '（验收模型未返回正文）';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `验收阶段模型调用失败：${message}\n\n原始 worker 摘要：\n${digest}`;
    }
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

export function parsePlanModeIntent(
  userInput: string,
  raw: string
):
  | { kind: 'chat'; reply: string; reason: string }
  | { kind: 'plan'; planText: string; reason: string }
  | undefined {
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
    if (kind === 'chat') {
      const reply =
        typeof obj.reply === 'string' && obj.reply.trim()
          ? obj.reply.trim()
          : typeof obj.message === 'string'
            ? obj.message.trim()
            : '';
      if (reply) {
        return { kind: 'chat', reply, reason };
      }
    }
    if (kind === 'plan') {
      const planText =
        typeof obj.plan === 'string' && obj.plan.trim()
          ? obj.plan.trim()
          : typeof obj.planText === 'string'
            ? obj.planText.trim()
            : '';
      if (planText) {
        return { kind: 'plan', planText, reason };
      }
    }
  } catch {
    // not JSON
  }
  // 非 JSON：若整段像闲聊回复且输入是问候，当 chat
  if (isCasualChatInput(userInput) && trimmed.length < 500) {
    return { kind: 'chat', reply: trimmed, reason: 'non-json freeform chat' };
  }
  // 否则当计划正文
  if (trimmed.length > 20) {
    return {
      kind: 'plan',
      planText: trimmed,
      reason: 'non-json freeform plan'
    };
  }
  return undefined;
}


