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
  ResolveToolApprovalInput
} from './agentRuntimeTypes';
import {
  buildConductorPlan,
  buildImpactMapFromRegistry,
  formatConductorExecutionSummary,
  formatConductorPlanSummary
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
  /** Held between conductor plan gate and /approve execution. */
  private pendingConductor: PendingConductorExecution | undefined;

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

  /** Last conductor plan awaiting /approve (if any). */
  getPendingConductorPlan(): PendingConductorExecution | undefined {
    return this.pendingConductor;
  }

  clearPendingConductorPlan(): void {
    this.pendingConductor = undefined;
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
    input: ContextInspectionInput = { requestedMode: 'normal' },
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

      if (detection.mode === 'normal' && this.options.llmClient) {
        yield* this.runNormalModeWithToolLoop(input, detection.mode, runId);
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

  private async *runNormalModeWithToolLoop(
    input: AgentRunInput,
    mode: Exclude<AgentMode, 'auto'>,
    runId: string
  ): AsyncIterable<AgentRunStreamEvent> {
    throwIfAborted(input.signal);
    this.sessionContext.beginTurn(input.input);
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
   * Conductor (指挥家): plan-first → approval gate → sequential subagents.
   * Impact prefers session workspace roots (/add-dir); falls back to projects.json.
   */
  private async runConductor(
    input: AgentRunInput,
    mode: Exclude<AgentMode, 'auto'>,
    runId: string,
    conductorReason: string | undefined
  ): Promise<AgentResult> {
    throwIfAborted(input.signal);
    this.syncProjectRegistrySource();

    if (input.approvals?.plan === true && this.pendingConductor) {
      return this.executeConductorPlan(runId, this.pendingConductor, input.signal);
    }

    return this.planConductor(input, mode, runId, conductorReason);
  }

  private async planConductor(
    input: AgentRunInput,
    mode: Exclude<AgentMode, 'auto'>,
    runId: string,
    conductorReason: string | undefined
  ): Promise<AgentResult> {
    const planned = this.buildConductorImpact(input.input);
    if (!planned.ok) {
      const failed = await this.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode,
          status: 'failed',
          summary: planned.summary,
          report: {
            changedFiles: [],
            evidence: planned.evidence,
            risks: []
          }
        })
      );
      await this.record(runId, 'run.completed', { ...failed });
      this.finishTurnWithAssistant(input.input, failed.summary);
      return failed;
    }

    const { impact, projectId, registrySourcePath } = planned;
    const plan = buildConductorPlan({
      goal: input.input,
      projectId,
      impact
    });

    await this.record(runId, 'plan.created', plan);
    await this.record(runId, 'impact_map.created', impact);
    await this.record(runId, 'approval.required', {
      scope: 'conductor-plan',
      reason: conductorReason,
      projectId,
      repos: impact.repos.map((repo) => repo.id)
    });

    const summary = formatConductorPlanSummary({
      plan,
      impact,
      registrySource: registrySourcePath
    });

    this.pendingConductor = {
      goal: input.input,
      mode,
      plan,
      impactMap: impact,
      projectId,
      registrySourcePath
    };

    if (input.approvals?.plan === true) {
      return this.executeConductorPlan(runId, this.pendingConductor, input.signal);
    }

    const cancelled = await this.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode,
        status: 'cancelled',
        cancellationReason: 'approval-gate',
        summary,
        report: {
          changedFiles: [],
          evidence: [
            `project=${projectId}`,
            `impact strategy=${impact.strategy}`,
            `repos=${impact.repos.map((r) => r.id).join(',')}`,
            '已在执行前触发确认门（plan-first，确认前不改文件）'
          ],
          risks: []
        }
      })
    );
    await this.record(runId, 'run.completed', { ...cancelled });
    this.finishTurnWithAssistant(input.input, cancelled.summary);
    return cancelled;
  }

  /**
   * Prefer /add-dir workspace roots (multi-dir always usable).
   * Else project registry. Else primary cwd alone as single-root conductor.
   */
  private buildConductorImpact(goal: string):
    | {
        ok: true;
        impact: import('../domain').ImpactMap;
        projectId: string;
        registrySourcePath?: string;
      }
    | { ok: false; summary: string; evidence: string[] } {
    const roots = this.options.workspaceRoots;
    if (roots && roots.list().length > 0) {
      // Multi-dir: if only primary, still allow conductor on single root
      const impact = roots.toImpactMap(goal);
      return {
        ok: true,
        impact,
        projectId: impact.projectId,
        registrySourcePath: undefined
      };
    }

    const registry = this.options.projectRegistry;
    if (registry) {
      const selection = selectActiveProject(registry, {
        activeProjectId: this.options.activeProjectId,
        workspaceRoot: this.options.workspaceRoot
      });
      if (!selection) {
        return {
          ok: false,
          summary:
            'project registry 已加载，但无法选定 active project。' +
            '请设置 defaultProjectId，或用 /add-dir 加入目录。',
          evidence: [
            `可用 projects: ${Object.keys(registry.projects).join(', ') || '(空)'}`
          ]
        };
      }
      return {
        ok: true,
        impact: buildImpactMapFromRegistry({
          projectId: selection.projectId,
          project: selection.project,
          goal
        }),
        projectId: selection.projectId,
        registrySourcePath: this.options.projectRegistryPath
      };
    }

    // Fallback: single primary workspace
    const primary = this.options.workspaceRoot;
    if (primary) {
      const ephemeral = new WorkspaceRoots(primary);
      return {
        ok: true,
        impact: ephemeral.toImpactMap(goal),
        projectId: 'workspace'
      };
    }

    return {
      ok: false,
      summary:
        '指挥家模式需要至少一个工作区：启动目录、/add-dir 额外目录，或 ~/.kross/projects.json。',
      evidence: [
        '提示：/add-dir <path> 加入其它仓库；/dirs 查看当前 roots'
      ]
    };
  }

  private async executeConductorPlan(
    runId: string,
    pending: PendingConductorExecution,
    signal?: AbortSignal
  ): Promise<AgentResult> {
    throwIfAborted(signal);
    const { mode, impactMap, plan, projectId, goal } = pending;

    await this.record(runId, 'conductor.execution.started', {
      projectId,
      repos: impactMap.repos.map((r) => r.id)
    });

    const runSubagent = this.options.runSubagent;
    if (!runSubagent) {
      const failed = await this.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode,
          status: 'failed',
          summary:
            '跨仓库计划已确认，但运行时未注入 runSubagent，无法派生子代理。',
          report: {
            changedFiles: [],
            evidence: ['缺少 AgentRuntimeOptions.runSubagent'],
            risks: []
          }
        })
      );
      await this.record(runId, 'run.completed', { ...failed });
      this.pendingConductor = undefined;
      this.finishTurnWithAssistant(goal, failed.summary);
      return failed;
    }

    const outcomes: Array<{
      repoId: string;
      status: string;
      summary: string;
      changedFiles: string[];
      risks: string[];
    }> = [];
    const allChanged: string[] = [];
    const allEvidence: string[] = [];
    const allRisks: string[] = [];

    for (const repo of impactMap.repos) {
      throwIfAborted(signal);
      const taskPrompt =
        repo.tasks?.[0] ??
        `在仓库 ${repo.id}（${repo.path}）中推进：${goal}`;
      try {
        const outcome = await runSubagent({
          prompt: taskPrompt,
          title: `conductor:${repo.id}`.slice(0, 48),
          mode: 'general',
          parentRunId: runId,
          parentDepth: 0,
          signal,
          repoId: repo.id,
          workspaceRoot: repo.path
        });
        const result = outcome.result;
        outcomes.push({
          repoId: repo.id,
          status: result.status,
          summary: result.summary,
          changedFiles: result.changedFiles,
          risks: result.risks
        });
        for (const file of result.changedFiles) {
          allChanged.push(`${repo.id}:${file}`);
        }
        allEvidence.push(
          `${repo.id}: ${result.status} — ${result.summary.slice(0, 200)}`
        );
        allRisks.push(...result.risks.map((r) => `${repo.id}: ${r}`));
      } catch (error) {
        if (isOperationAborted(error, signal)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        outcomes.push({
          repoId: repo.id,
          status: 'failed',
          summary: message,
          changedFiles: [],
          risks: [message]
        });
        allEvidence.push(`${repo.id}: failed — ${message}`);
        allRisks.push(`${repo.id}: ${message}`);
      }
    }

    const summary = formatConductorExecutionSummary({
      projectId,
      goal,
      outcomes
    });
    const anyFailed = outcomes.some((o) => o.status === 'failed');

    const result = await this.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode,
        status: anyFailed ? 'failed' : 'completed',
        summary,
        report: {
          changedFiles: allChanged,
          evidence: [
            `project=${projectId}`,
            `plan steps=${plan.steps.length}`,
            ...allEvidence
          ],
          risks: allRisks
        }
      })
    );

    await this.record(runId, 'review.completed', {
      status: result.status,
      summary: result.summary,
      repos: outcomes.map((o) => ({ repoId: o.repoId, status: o.status }))
    });
    await this.record(runId, 'run.completed', { ...result });
    this.pendingConductor = undefined;
    this.finishTurnWithAssistant(goal, result.summary);
    return result;
  }

  private async finishRunWithoutLlm(
    input: AgentRunInput,
    mode: Exclude<AgentMode, 'auto'>,
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
    mode: Exclude<AgentMode, 'auto'>;
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


