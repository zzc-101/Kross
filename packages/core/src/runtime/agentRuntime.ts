import { EventEmitter } from 'node:events';

import {
  type AgentMode,
  type AgentResult,
  type TraceEvent,
  agentResultSchema
} from '../domain';
import {
  InMemoryContextManager,
  type ContextManager
} from '../context/contextManager';
import {
  estimateTokensFromChars,
  formatContextUsage,
  resolveModelContextWindow
} from '../llm/modelContextWindows';
import {
  cycleThinkingEffort,
  DEFAULT_THINKING_EFFORT,
  formatModelEffortLabel,
  type ThinkingEffort
} from '../llm/thinkingEffort';
import type {
  LlmClient,
  LlmMessage,
  LlmToolCall
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
  formatMaxIterationsNotice,
  PLANNER_SYSTEM_PROMPT,
  RuntimeToolLoop,
  toLlmTools
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

/**
 * 工具调用轮次安全上限（默认）。
 * 一轮 = 模型发 tool_calls → 执行 → 回填再问模型。
 *
 * 行业做法（见 README）：
 * - OpenCode：默认不限制，用户可设 steps；实现里约 1000 作硬保险
 * - Codex：基本不按步数掐断，靠用量/上下文/用户中断
 * - Claude Code：会话可跑很多轮工具，另有「单 turn 工具次数」产品限制
 *
 * 我们默认用较高安全网，触顶时 **软着陆**（强制文本总结），而不是直接 failed。
 */
export class AgentRuntime extends EventEmitter {
  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly contextManager: ContextManager;
  private readonly toolGateway: ToolGateway | undefined;
  private readonly inspection: RuntimeInspection;
  private readonly toolLoop: RuntimeToolLoop;
  private permissionMode: PermissionMode = 'default';

  constructor(private readonly options: AgentRuntimeOptions) {
    super();
    this.createRunId =
      options.createRunId ?? (() => `run-${Date.now().toString(36)}`);
    this.now = options.now ?? (() => new Date());
    this.contextManager = options.contextManager ?? new InMemoryContextManager();
    this.toolGateway = options.toolGateway;
    this.inspection = new RuntimeInspection(options);
    this.toolLoop = new RuntimeToolLoop({
      llmClient: options.llmClient,
      toolGateway: this.toolGateway,
      contextManager: this.contextManager,
      maxToolIterations: options.maxToolIterations,
      record: (runId, type, payload) => this.record(runId, type, payload),
      attachChangedFiles: (result) => this.attachChangedFiles(result),
      appendConversation: (userInput, assistantOutput) =>
        this.appendConversation(userInput, assistantOutput)
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

  /** TUI 输入框右下角：`model (thinkingEffort)`，不含 provider。 */
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
  }

  setModel(model: string): void {
    const client = this.options.llmClient;
    if (!client?.setModel) {
      throw new Error('当前 LLM 客户端不支持切换模型');
    }
    client.setModel(model);
  }

  /**
   * 当前会话上下文占用估算（用于顶栏 12K/128K 展示）。
   * used 来自 ContextManager 字符预算 /4；max 来自模型窗口表或 AGENT_CONTEXT_WINDOW。
   */
  getContextUsage(input: {
    requestedMode: AgentMode;
    currentUserInput?: string;
    env?: Record<string, string | undefined>;
  }): {
    usedChars: number;
    usedTokens: number;
    maxTokens: number;
    label: string;
    ratio: number;
  } {
    const snapshot = this.inspectContext({
      requestedMode: input.requestedMode,
      currentUserInput: input.currentUserInput
    });
    const usedTokens = estimateTokensFromChars(snapshot.estimatedChars);
    const maxTokens = resolveModelContextWindow(
      this.options.llmClient?.model,
      input.env ?? process.env
    );
    return {
      usedChars: snapshot.estimatedChars,
      usedTokens,
      maxTokens,
      label: formatContextUsage(usedTokens, maxTokens),
      ratio: usedTokens / Math.max(1, maxTokens)
    };
  }

  /**
   * 订阅 trace 事件。若 traceStore 为 ObservableTraceStore，可收到
   * runtime + ToolGateway 全部写入；否则回退为 runtime 自身 emit 的 event
   *（此时 ToolGateway 的 tool_call.* 不会到达订阅方，TUI 工具卡片会静默失效）。
   */
  onTrace(listener: TraceEventListener): () => void {
    if (isObservableTraceStore(this.options.traceStore)) {
      return this.options.traceStore.subscribe(listener);
    }

    // 无 ToolGateway 时退回 runtime emit 即可；有工具时才需要 Observable 才能收到 tool_call.*
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

  /** 最近 N 次 run 的摘要（供 /trace）。 */
  async listTraces(options: ListRunsOptions = {}): Promise<RunTraceSummary[]> {
    return this.inspection.listTraces(options);
  }

  /** 单次 run 详情；不存在时返回 null。 */
  async inspectTrace(runId: string): Promise<RunTraceDetail | null> {
    return this.inspection.inspectTrace(runId);
  }

  /** /trace 命令文本输出。 */
  async formatTraceCommand(argument?: string): Promise<string> {
    return this.inspection.formatTraceCommand(argument);
  }

  /**
   * /diff 命令文本输出。
   * - 无参数：最近一次 run 的 agent 触达文件 + 工作区 git 状态
   * - 有 runId：只汇总该 run 的触达文件，并附带当前 git 状态
   */
  async formatDiffCommand(argument?: string): Promise<string> {
    return this.inspection.formatDiffCommand(argument);
  }

  async run(input: AgentRunInput): Promise<AgentResult> {
    const runId = this.createRunId();

    await this.record(runId, 'run.started', { input: input.input });
    await this.record(runId, 'planner.started', {
      requestedMode: input.requestedMode
    });

    const detection = detectMode({
      requestedMode: input.requestedMode,
      input: input.input
    });

    await this.record(runId, 'mode.detected', { ...detection });

    const plannerOutcome = await this.toolLoop.createPlannerSuggestion(
      runId,
      input.input,
      detection.mode
    );
    if (plannerOutcome?.kind === 'approval') {
      const approval = await this.attachChangedFiles(plannerOutcome.result);
      await this.record(runId, 'run.awaiting_approval', {
        pendingApproval: approval.pendingApproval
      });
      return approval;
    }
    if (plannerOutcome?.kind === 'max-iterations') {
      const failed = await this.toolLoop.createMaxToolIterationsResult(
        runId,
        detection.mode,
        plannerOutcome.message
      );
      await this.record(runId, 'review.completed', {
        status: failed.status,
        summary: failed.summary
      });
      await this.record(runId, 'run.completed', { ...failed });
      this.appendConversation(input.input, failed.summary);
      return failed;
    }
    if (plannerOutcome?.kind === 'failure') {
      const failed = await this.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode: detection.mode,
          status: 'failed',
          summary: `模型请求失败：${plannerOutcome.message}`,
          report: {
            changedFiles: [],
            evidence: [`LLM 请求失败: ${plannerOutcome.message}`],
            risks: ['请检查模型名称、baseUrl、鉴权方式或网络连通性']
          }
        })
      );
      await this.record(runId, 'review.completed', {
        status: failed.status,
        summary: failed.summary
      });
      await this.record(runId, 'run.completed', { ...failed });
      return failed;
    }
    const plannerSuggestion =
      plannerOutcome?.kind === 'response' ? plannerOutcome.response : undefined;

    const plan = createPlan(input.input, detection.mode, plannerSuggestion?.text);
    await this.record(runId, 'plan.created', plan);

    if (detection.mode === 'normal' && !plannerSuggestion) {
      const missingModel = await this.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode: detection.mode,
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

      await this.record(runId, 'review.completed', {
        status: missingModel.status,
        summary: missingModel.summary
      });
      await this.record(runId, 'run.completed', { ...missingModel });
      return missingModel;
    }

    if (detection.mode === 'cross-repo') {
      await this.record(runId, 'approval.required', {
        scope: 'cross-repo-plan',
        reason: detection.reason
      });

      if (input.approvals?.plan !== true) {
        const cancelled = await this.attachChangedFiles(
          agentResultSchema.parse({
            runId,
            mode: detection.mode,
            status: 'cancelled',
            summary: '跨仓库计划等待确认，当前运行已取消',
            report: {
              changedFiles: [],
              evidence: [
                ...(plannerSuggestion ? ['planner LLM 已返回计划建议'] : []),
                '已在执行前触发确认门'
              ],
              risks: []
            }
          })
        );
        await this.record(runId, 'run.completed', { ...cancelled });
        this.appendConversation(input.input, cancelled.summary);
        return cancelled;
      }

      await this.record(runId, 'impact_map.created', {
        strategy: 'codegraph-placeholder',
        repos: [],
        note: '后续接入 codegraph adapter 后填充真实影响面'
      });
    }

    const result = await this.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode: detection.mode,
        status: 'completed',
        summary:
          detection.mode === 'cross-repo'
            ? '跨仓库任务计划已创建，等待接入子代理执行'
            : plannerSuggestion?.text ?? '未配置模型，无法生成真实回复。',
        report: {
          changedFiles: [],
          evidence:
            detection.mode === 'cross-repo'
              ? [
                  ...(plannerSuggestion ? ['planner LLM 已返回计划建议'] : []),
                  '已生成跨仓库影响面占位图'
                ]
              : [
                  ...(plannerSuggestion ? ['planner LLM 已返回计划建议'] : []),
                  '已记录普通任务 trace'
                ],
          risks:
            detection.mode === 'cross-repo'
              ? ['当前版本尚未接入真实 codegraph 和子代理执行']
              : []
        }
      })
    );

    await this.record(runId, 'review.completed', {
      status: result.status,
      summary: result.summary
    });
    await this.record(runId, 'run.completed', { ...result });
    this.appendConversation(input.input, result.summary);

    return result;
  }

  async *runStreaming(input: AgentRunInput): AsyncIterable<AgentRunStreamEvent> {
    const detection = detectMode({
      requestedMode: input.requestedMode,
      input: input.input
    });
    if (detection.mode !== 'normal' || !this.options.llmClient) {
      yield { type: 'result', result: await this.run(input) };
      return;
    }

    const runId = this.createRunId();

    await this.record(runId, 'run.started', { input: input.input });
    await this.record(runId, 'planner.started', {
      requestedMode: input.requestedMode
    });
    await this.record(runId, 'mode.detected', { ...detection });

    const tools = this.toolGateway?.listTools({ mode: detection.mode }) ?? [];
    const context = this.contextManager.build({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      currentUserInput: input.input,
      mode: detection.mode,
      tools
    });

    await this.record(runId, 'context.built', {
      includedSources: context.includedSources,
      droppedSources: context.droppedSources,
      estimatedChars: context.estimatedChars,
      report: context.report
    });

    const maxIterations =
      this.options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    let messages = context.messages;
    let iteration = 1;
    let fullText = '';
    let fullThinking = '';

    try {
      while (true) {
        let turnText = '';
        let turnThinking = '';
        const toolCalls: LlmToolCall[] = [];

        yield { type: 'turn-start', iteration };

        for await (const chunk of this.options.llmClient.stream({
          messages,
          tools: toLlmTools(tools),
          temperature: 0.2,
          metadata: {
            purpose: iteration === 1 ? 'planner' : 'planner-tool-followup',
            iteration,
            includedSources: context.includedSources,
            droppedSources: context.droppedSources,
            contextReport: context.report
          }
        })) {
          if (chunk.type === 'thinking-delta') {
            if (turnThinking.length === 0 && fullThinking.length > 0) {
              fullThinking += '\n\n';
            }
            turnThinking += chunk.text;
            fullThinking += chunk.text;
            yield { type: 'thinking-delta', text: chunk.text };
          } else if (chunk.type === 'text-delta') {
            if (turnText.length === 0 && fullText.length > 0) {
              fullText += '\n\n';
            }
            turnText += chunk.text;
            fullText += chunk.text;
            yield { type: 'text-delta', text: chunk.text };
          } else if (chunk.type === 'tool-call') {
            toolCalls.push(chunk.call);
          }
        }

        await this.record(
          runId,
          iteration === 1 ? 'llm.planner.completed' : 'llm.tool_followup.completed',
          {
            provider: this.options.llmClient.provider,
            model: 'stream',
            textPreview: turnText.slice(0, 240),
            thinkingPreview: turnThinking.slice(0, 240) || undefined,
            toolCallCount: toolCalls.length,
            ...(iteration === 1 ? {} : { iteration })
          }
        );

        if (toolCalls.length > 0 && iteration > maxIterations) {
          // 触顶：不执行本轮 tool_calls，软着陆为文本总结（对齐 OpenCode steps 行为）
          await this.record(runId, 'llm.tool_loop.max_iterations', {
            maxIterations,
            iteration,
            pendingToolCallCount: toolCalls.length,
            calls: toolCalls.map((call) => ({ id: call.id, name: call.name })),
            softLand: true
          });

          yield { type: 'turn-start', iteration };
          let softText = '';
          for await (const chunk of this.toolLoop.streamSoftLand({
            runId,
            messages,
            maxIterations,
            iteration
          })) {
            if (chunk.type === 'text-delta') {
              softText += chunk.text;
              fullText = fullText.length > 0 ? `${fullText}\n\n${chunk.text}` : chunk.text;
              yield chunk;
            }
          }

          const summary =
            softText.trim() ||
            fullText.trim() ||
            formatMaxIterationsNotice(maxIterations);
          const landed = await this.attachChangedFiles(
            agentResultSchema.parse({
              runId,
              mode: detection.mode,
              status: 'completed',
              summary,
              report: {
                changedFiles: [],
                evidence: [
                  `工具调用达到上限 ${maxIterations} 轮，已软着陆为总结`
                ],
                risks: ['部分计划可能未执行完，可继续对话推进']
              }
            })
          );
          await this.record(runId, 'review.completed', {
            status: landed.status,
            summary: landed.summary
          });
          await this.record(runId, 'run.completed', { ...landed });
          this.appendConversation(input.input, landed.summary);
          yield { type: 'result', result: landed };
          return;
        }

        if (toolCalls.length === 0 || !this.toolGateway) {
          break;
        }

        yield {
          type: 'tools-start',
          iteration,
          count: toolCalls.length
        };

        await this.record(runId, 'llm.tool_calls.received', {
          count: toolCalls.length,
          iteration,
          calls: toolCalls.map((call) => ({ id: call.id, name: call.name }))
        });

        const assistantMessage: LlmMessage = {
          role: 'assistant',
          content: turnText,
          toolCalls
        };
        const batchMessages: LlmMessage[] = [...messages, assistantMessage];
        const batch = await this.toolLoop.executeToolBatch({
          runId,
          mode: detection.mode,
          calls: toolCalls,
          completedToolMessages: [],
          messages: batchMessages,
          tools,
          iteration
        });
        if (batch.kind === 'approval') {
          const approval = await this.attachChangedFiles(batch.result);
          await this.record(runId, 'run.awaiting_approval', {
            pendingApproval: approval.pendingApproval
          });
          yield { type: 'result', result: approval };
          return;
        }

        messages = [...batchMessages, ...batch.toolMessages];
        iteration += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.record(runId, 'llm.planner.failed', { message });
      const failed = await this.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode: detection.mode,
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
      yield { type: 'result', result: failed };
      return;
    }

    const plan = createPlan(input.input, detection.mode, fullText);
    await this.record(runId, 'plan.created', {
      ...plan,
      thinkingPreview: fullThinking.slice(0, 240) || undefined
    });

    const result = await this.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode: detection.mode,
        status: 'completed',
        summary: fullText,
        report: {
          changedFiles: [],
          evidence: [
            'planner LLM 已返回计划建议',
            '已记录普通任务 trace',
            ...(fullThinking.length > 0 ? ['模型返回了 thinking 过程'] : [])
          ],
          risks: []
        }
      })
    );

    await this.record(runId, 'review.completed', {
      status: result.status,
      summary: result.summary
    });
    await this.record(runId, 'run.completed', { ...result });
    this.appendConversation(input.input, result.summary);

    yield { type: 'result', result };
  }

  inspectContext(input: ContextInspectionInput): ContextInspection {
    const currentUserInput = input.currentUserInput ?? '';
    const mode =
      input.requestedMode === 'auto'
        ? currentUserInput.trim().length > 0
          ? detectMode({
              requestedMode: input.requestedMode,
              input: currentUserInput
            }).mode
          : 'normal'
        : input.requestedMode;
    const snapshot = this.contextManager.build({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      currentUserInput,
      mode,
      tools: this.toolGateway?.listTools({ mode }) ?? []
    });

    return {
      ...snapshot,
      mode
    };
  }

  async resolveToolApproval(input: ResolveToolApprovalInput): Promise<AgentResult> {
    return this.toolLoop.resolveToolApproval(input);
  }

  /** Stream follow-up after tool approval (preferred by TUI). */
  resolveToolApprovalStreaming(
    input: ResolveToolApprovalInput
  ): AsyncIterable<AgentRunStreamEvent> {
    return this.toolLoop.resolveToolApprovalStreaming(input);
  }

  /** 从当前 run 的 trace 回填 report.changedFiles（Write/Edit 成功路径）。 */
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

  private appendConversation(userInput: string, assistantOutput: string): void {
    this.contextManager.appendConversation({
      role: 'user',
      content: userInput
    });
    this.contextManager.appendConversation({
      role: 'assistant',
      content: assistantOutput
    });
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
  mode: Exclude<AgentMode, 'auto'>,
  llmSuggestion?: string
) {
  if (mode === 'cross-repo') {
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

  return {
    goal,
    llmSuggestion,
    steps: ['理解目标', '探索当前 workspace', '执行修改或回答', '验收并记录 trace']
  };
}
