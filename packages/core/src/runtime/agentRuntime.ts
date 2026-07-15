import { EventEmitter } from 'node:events';

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
  type ContextSnapshot
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
import type { ListRunsOptions } from '../trace/traceStore';
import type { RunTraceDetail, RunTraceSummary } from '../trace/traceSummary';
import type {
  AgentRunInput,
  AgentRunStreamEvent,
  AgentRuntimeOptions,
  ContextInspection,
  ContextInspectionInput,
  ResolveToolApprovalInput
} from './agentRuntimeTypes';
import { RuntimeInspection } from './runtimeInspection';
import {
  DEFAULT_MAX_TOOL_ITERATIONS,
  PLANNER_SYSTEM_PROMPT,
  RuntimeToolLoop
} from './toolLoop';

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
      appendAssistantForCancel: (summary) =>
        this.sessionContext.appendAssistant(summary),
      syncTodoContext: () => this.syncTodoContextSource(),
      onContextMaintained: (runId, maintenance) =>
        this.recordContextMaintenanceEvents(runId, maintenance)
    });
    if (this.toolGateway) {
      this.toolGateway.setApprovalPolicy(createApprovalPolicy(this.permissionMode));
    }
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

  getLastContextMaintenance(): ContextMaintenanceResult | undefined {
    return this.sessionContext.getLastMaintenance();
  }

  getAllContextMaintenance(): ContextMaintenanceResult[] {
    return this.sessionContext.getAllMaintenance();
  }

  getPreserveFullTurns(): number {
    return this.sessionContext.getPolicy().preserveFullTurns;
  }

  async compactNow(input: ContextInspectionInput = {
    requestedMode: 'normal'
  }): Promise<ContextMaintenanceResult> {
    const { buildContextInput } = this.resolveContextBuildInput(input);
    return this.sessionContext.compactNow(buildContextInput);
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
  } {
    const snapshot = this.inspectContext({
      requestedMode: input.requestedMode,
      currentUserInput: input.currentUserInput
    });
    const client = this.options.llmClient;
    const usedTokens = snapshot.estimatedTokens;
    const maxTokens = snapshot.inputBudget;
    const compactThreshold = snapshot.compactThreshold;
    const lastUsageTokens = client?.lastUsage?.inputTokens;
    return {
      usedChars: snapshot.estimatedChars,
      usedTokens,
      maxTokens,
      compactThreshold,
      lastUsageTokens,
      label: formatContextUsage(usedTokens, maxTokens),
      ratio: usedTokens / Math.max(1, compactThreshold)
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

    await this.record(runId, 'run.started', { input: input.input });
    await this.record(runId, 'planner.started', {
      requestedMode: input.requestedMode
    });
    await this.record(runId, 'mode.detected', { ...detection });

    if (detection.mode === 'normal' && this.options.llmClient) {
      yield* this.runNormalModeWithToolLoop(input, detection.mode, runId);
      return;
    }

    if (detection.mode === 'cross-repo' && this.options.llmClient) {
      const result = await this.runCrossRepoWithToolLoop(
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
  }

  private async *runNormalModeWithToolLoop(
    input: AgentRunInput,
    mode: Exclude<AgentMode, 'auto'>,
    runId: string
  ): AsyncIterable<AgentRunStreamEvent> {
    this.sessionContext.beginTurn(input.input);
    const { buildContextInput, tools } = this.buildPlannerContext(mode);
    const prepared = await this.sessionContext.prepareRequest(buildContextInput);
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
        }
      }
    });
  }

  private async runCrossRepoWithToolLoop(
    input: AgentRunInput,
    mode: Exclude<AgentMode, 'auto'>,
    runId: string,
    crossRepoReason: string | undefined
  ): Promise<AgentResult> {
    this.sessionContext.beginTurn(input.input);
    const { buildContextInput, tools } = this.buildPlannerContext(mode);
    const prepared = await this.sessionContext.prepareRequest(buildContextInput);
    await this.recordPlannerContext(runId, prepared);

    let loopResult: AgentResult | undefined;
    let softLanded = false;
    for await (const event of this.toolLoop.runStreamingToolLoop({
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
      handlers: {
        onSuccess: async ({ fullText }) =>
          this.attachChangedFiles(
            agentResultSchema.parse({
              runId,
              mode,
              status: 'completed',
              summary: fullText,
              report: {
                changedFiles: [],
                evidence: ['planner LLM 已返回计划建议'],
                risks: []
              }
            })
          ),
        onSoftLand: async ({ summary }) => {
          softLanded = true;
          this.sessionContext.appendAssistant(summary);
          const landed = await this.toolLoop.createMaxToolIterationsResult(
            runId,
            mode,
            summary
          );
          await this.record(runId, 'review.completed', {
            status: landed.status,
            summary: landed.summary
          });
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
          await this.record(runId, 'review.completed', {
            status: failed.status,
            summary: failed.summary
          });
          await this.record(runId, 'run.completed', { ...failed });
          this.sessionContext.abortTurn(message);
          return failed;
        }
      }
    })) {
      if (event.type === 'result') {
        loopResult = event.result;
      }
    }

    if (!loopResult) {
      throw new Error(`Cross-repo run finished without result: ${runId}`);
    }

    if (
      loopResult.status === 'approval-required' ||
      loopResult.status === 'failed' ||
      softLanded
    ) {
      return loopResult;
    }

    this.sessionContext.commitTurn();
    return this.finalizeCrossRepoRun(
      input,
      mode,
      runId,
      loopResult.summary,
      crossRepoReason
    );
  }

  private async finishRunWithoutLlm(
    input: AgentRunInput,
    mode: Exclude<AgentMode, 'auto'>,
    runId: string,
    crossRepoReason: string | undefined
  ): Promise<AgentResult> {
    if (mode === 'normal') {
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

    return this.finalizeCrossRepoRun(
      input,
      mode,
      runId,
      undefined,
      crossRepoReason
    );
  }

  private async finalizeCrossRepoRun(
    input: AgentRunInput,
    mode: Exclude<AgentMode, 'auto'>,
    runId: string,
    llmSuggestion: string | undefined,
    crossRepoReason: string | undefined
  ): Promise<AgentResult> {
    const plan = createPlan(input.input, mode, llmSuggestion);
    await this.record(runId, 'plan.created', plan);

    await this.record(runId, 'approval.required', {
      scope: 'cross-repo-plan',
      reason: crossRepoReason
    });

    if (input.approvals?.plan !== true) {
      const cancelled = await this.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode,
          status: 'cancelled',
          summary: '跨仓库计划等待确认，当前运行已取消',
          report: {
            changedFiles: [],
            evidence: [
              ...(llmSuggestion ? ['planner LLM 已返回计划建议'] : []),
              '已在执行前触发确认门'
            ],
            risks: []
          }
        })
      );
      await this.record(runId, 'run.completed', { ...cancelled });
      this.finishTurnWithAssistant(input.input, cancelled.summary);
      return cancelled;
    }

    await this.record(runId, 'impact_map.created', {
      strategy: 'codegraph-placeholder',
      repos: [],
      note: '后续接入 codegraph adapter 后填充真实影响面'
    });

    const result = await this.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode,
        status: 'completed',
        summary: '跨仓库任务计划已创建，等待接入子代理执行',
        report: {
          changedFiles: [],
          evidence: [
            ...(llmSuggestion ? ['planner LLM 已返回计划建议'] : []),
            '已生成跨仓库影响面占位图'
          ],
          risks: ['当前版本尚未接入真实 codegraph 和子代理执行']
        }
      })
    );

    await this.record(runId, 'review.completed', {
      status: result.status,
      summary: result.summary
    });
    await this.record(runId, 'run.completed', { ...result });
    this.finishTurnWithAssistant(input.input, result.summary);
    return result;
  }

  private finishTurnWithAssistant(userInput: string, assistantOutput: string): void {
    if (!this.sessionContext.getThread().getOpenTurnId()) {
      this.sessionContext.beginTurn(userInput);
    }
    this.sessionContext.appendAssistant(assistantOutput);
    this.sessionContext.commitTurn();
  }

  private buildPlannerContext(mode: Exclude<AgentMode, 'auto'>): {
    buildContextInput: {
      systemPrompt: string;
      mode: Exclude<AgentMode, 'auto'>;
      tools: ToolMetadata[];
    };
    tools: ToolMetadata[];
  } {
    const tools = this.toolGateway?.listTools({ mode }) ?? [];
    this.syncTodoContextSource();
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
    mode: Exclude<AgentMode, 'auto'>;
    buildContextInput: {
      systemPrompt: string;
      mode: Exclude<AgentMode, 'auto'>;
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
          : 'normal'
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

function createPlan(
  goal: string,
  _mode: Exclude<AgentMode, 'auto'>,
  llmSuggestion?: string
) {
  return {
    goal,
    llmSuggestion,
    steps: [
      '读取 project registry',
      '使用 codegraph 生成跨仓库影响面',
      '拆分 repo 级子任务',
      '等待用户确认后执行'
    ]
  };
}
