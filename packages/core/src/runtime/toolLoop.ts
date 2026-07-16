import type { SessionContext } from '../context/sessionContext';
import {
  abortMessage,
  abortReason,
  isOperationAborted,
  throwIfAborted
} from '../abort';
import {
  agentResultSchema,
  type AgentMode,
  type AgentResult,
  type PendingToolApproval
} from '../domain';
import type {
  LlmClient,
  LlmMessage,
  LlmToolCall
} from '../llm/types';
import { formatToolInputPreview } from '../tools/formatToolInputPreview';
import {
  ToolPermissionError,
  type ToolGateway,
  type ToolMetadata,
  type ToolResult
} from '../tools/toolGateway';
import type {
  AgentRunStreamEvent,
  ResolveToolApprovalInput
} from './agentRuntimeTypes';
import {
  createMissingLlmAfterApprovalResult,
  DEFAULT_MAX_TOOL_ITERATIONS,
  formatMaxIterationsNotice,
  runStreamingToolLoop,
  ToolBatchAbortedError,
  type CancellationStage,
  type StreamingToolLoopDeps,
  type StreamingToolLoopParams,
  type ToolBatchOutcome
} from './streamingToolLoop';
import { toLlmTools } from './toolLoopShared';

export { toLlmTools } from './toolLoopShared';

const SOFT_LAND_FALLBACK =
  '已达到工具调用轮次上限。请查看上文工具结果；如需继续，请再发一条指令推进剩余工作。';

export {
  DEFAULT_MAX_TOOL_ITERATIONS,
  formatMaxIterationsNotice
} from './streamingToolLoop';

export const PLANNER_SYSTEM_PROMPT = [
  '你是本地 agent 的执行助手。Mode 是会话策略（auto/plan/conductor），不是输出管线。',
  '需要工具时只能使用可用工具清单中的工具，不要编造工具。',
  '当用户要求切换模式（如「切到指挥家」「用 plan 模式」「回到 auto」）时，必须调用 SetMode 工具，',
  '不要声称自己无法切换 Mode。切换从下一轮用户消息生效；当前轮用一句话确认即可。',
  'Mode 含义：auto=默认 agent；plan=先计划后开发；conductor=高级模型拆任务+worker 执行+验收。',
  '多目录工作区用 /add-dir（用户命令），不要用 SetMode。'
].join('');

interface PendingToolSession {
  runId: string;
  mode: AgentMode;
  originalUserInput: string;
  call: LlmToolCall;
  remainingCalls: LlmToolCall[];
  tools: ToolMetadata[];
  iteration: number;
}

export interface RuntimeToolLoopOptions {
  llmClient?: LlmClient;
  toolGateway?: ToolGateway;
  sessionContext: SessionContext;
  maxToolIterations?: number;
  record(
    runId: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<void>;
  attachChangedFiles(result: AgentResult): Promise<AgentResult>;
  commitTurn(): void;
  abortTurn(reason: string): void;
  interruptTurn(reason: string): void;
  appendAssistantForCancel(summary: string): void;
  /** Refresh session todo list into context sources before model calls. */
  syncTodoContext?: () => void;
  onContextMaintained?(
    runId: string,
    maintenance: import('../context/contextGovernor').ContextMaintenanceResult[]
  ): Promise<void>;
}

export class RuntimeToolLoop {
  private readonly pendingToolSessions = new Map<string, PendingToolSession>();

  constructor(private readonly options: RuntimeToolLoopOptions) {}

  setLlmClient(client: LlmClient | undefined): void {
    this.options.llmClient = client;
    this.options.sessionContext.setLlmClient(client);
  }

  /**
   * 取消所有内存中悬挂的工具审批会话（进程退出等场景）。
   * open turn 上 abort + 取消说明写入 committed 对话。
   */
  async cancelPendingApprovals(reason?: string): Promise<string[]> {
    const reasonText = reason ?? 'pending tool approval cancelled';
    const cancelledRunIds: string[] = [];

    for (const [runId, session] of this.pendingToolSessions) {
      this.pendingToolSessions.delete(runId);
      await this.finishPendingApprovalCancellation(
        session,
        reasonText,
        'system'
      );
      cancelledRunIds.push(runId);
    }

    return cancelledRunIds;
  }

  async interruptPendingApproval(
    runId: string,
    reason = '用户按下 Esc'
  ): Promise<AgentResult | undefined> {
    const session = this.pendingToolSessions.get(runId);
    if (!session) {
      return undefined;
    }
    this.pendingToolSessions.delete(runId);
    return this.finishPendingApprovalCancellation(
      session,
      reason,
      'user-interrupt'
    );
  }

  async resolveToolApproval(
    input: ResolveToolApprovalInput
  ): Promise<AgentResult> {
    let result: AgentResult | undefined;
    for await (const event of this.resolveToolApprovalStreaming(input)) {
      if (event.type === 'result') {
        result = event.result;
      }
    }
    if (!result) {
      throw new Error(`No result for tool approval resume: ${input.runId}`);
    }
    return result;
  }

  async *resolveToolApprovalStreaming(
    input: ResolveToolApprovalInput
  ): AsyncIterable<AgentRunStreamEvent> {
    const session = this.pendingToolSessions.get(input.runId);
    if (!session) {
      throw new Error(`No pending tool approval for run: ${input.runId}`);
    }
    this.pendingToolSessions.delete(input.runId);

    try {
      throwIfAborted(input.signal);
    const toolMessage = input.approved
      ? await this.executeApprovedToolCall(session, input.signal)
      : await this.createRejectedToolMessage(session);
    throwIfAborted(input.signal);

    if (toolMessage.role === 'tool') {
      this.options.sessionContext.appendToolResult({
        toolCallId: toolMessage.toolCallId,
        name: toolMessage.name,
        content: toolMessage.content,
        iteration: session.iteration
      });
    }

    const batch = await this.executeToolBatch({
      runId: session.runId,
      mode: session.mode,
      originalUserInput: session.originalUserInput,
      calls: session.remainingCalls,
      tools: session.tools,
      iteration: session.iteration,
      signal: input.signal
    });
    this.appendToolMessages(
      batch.kind === 'completed'
        ? batch.toolMessages
        : batch.completedToolMessages,
      session.iteration
    );
    throwIfAborted(input.signal);
    if (batch.kind === 'approval') {
      const approval = await this.options.attachChangedFiles(batch.result);
      await this.options.record(session.runId, 'run.awaiting_approval', {
        pendingApproval: approval.pendingApproval
      });
      yield { type: 'result', result: approval };
      return;
    }

    if (!this.options.llmClient) {
      const failed = await this.options.attachChangedFiles(
        createMissingLlmAfterApprovalResult(session.runId, session.mode)
      );
      await this.options.record(session.runId, 'run.completed', { ...failed });
      this.options.appendAssistantForCancel(failed.summary);
      this.options.commitTurn();
      yield { type: 'result', result: failed };
      return;
    }

    const buildContextInput = {
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      mode: session.mode,
      tools: session.tools
    };

    yield* runStreamingToolLoop(this.createStreamingDeps(), {
      runId: session.runId,
      mode: session.mode,
      originalUserInput: session.originalUserInput,
      sessionContext: this.options.sessionContext,
      buildContextInput,
      tools: session.tools,
      startIteration: session.iteration,
      firstStreamPurpose: 'planner-tool-followup',
      streamMetadata: { approvalResolved: input.approved },
      signal: input.signal,
      handlers: {
        onSuccess: async ({ fullText, fullThinking }) => {
          const result = await this.options.attachChangedFiles(
            agentResultSchema.parse({
              runId: session.runId,
              mode: session.mode,
              status: 'completed',
              summary: fullText,
              thinking: fullThinking || undefined,
              report: {
                changedFiles: [],
                evidence: [],
                risks: []
              }
            })
          );
          await this.options.record(session.runId, 'run.completed', { ...result });
          this.options.commitTurn();
          return result;
        },
        onSoftLand: async ({ summary }) => {
          const landed = await this.createMaxToolIterationsResult(
            session.runId,
            session.mode,
            summary
          );
          await this.options.record(session.runId, 'run.completed', { ...landed });
          this.options.appendAssistantForCancel(landed.summary);
          this.options.commitTurn();
          return landed;
        },
        onFailure: async (message) => {
          const failed = await this.options.attachChangedFiles(
            agentResultSchema.parse({
              runId: session.runId,
              mode: session.mode,
              status: 'failed',
              summary: `工具审批后续请求失败：${message}`,
              report: {
                changedFiles: [],
                evidence: [`LLM 请求失败: ${message}`],
                risks: ['请检查模型配置或网络连通性']
              }
            })
          );
          await this.options.record(session.runId, 'run.completed', { ...failed });
          this.options.abortTurn(message);
          return failed;
        },
        onCancelled: async ({ reason, stage }) =>
          this.finishInterruptedRun(session, reason, stage)
        }
      }
    );
    } catch (error) {
      if (!isOperationAborted(error, input.signal)) {
        throw error;
      }
      this.pendingToolSessions.delete(session.runId);
      if (error instanceof ToolBatchAbortedError) {
        this.appendToolMessages(error.completedToolMessages, session.iteration);
      }
      const cancelled = await this.finishInterruptedRun(
        session,
        abortMessage(input.signal),
        'tool'
      );
      yield { type: 'result', result: cancelled };
    }
  }

  runStreamingToolLoop(
    params: StreamingToolLoopParams
  ): AsyncIterable<AgentRunStreamEvent> {
    if (!this.options.llmClient) {
      throw new Error('runStreamingToolLoop requires llmClient');
    }
    return runStreamingToolLoop(this.createStreamingDeps(), params);
  }

  async executeToolBatch(input: {
    runId: string;
    mode: AgentMode;
    originalUserInput: string;
    calls: LlmToolCall[];
    tools: ToolMetadata[];
    iteration: number;
    signal?: AbortSignal;
  }): Promise<ToolBatchOutcome> {
    const toolMessages: LlmMessage[] = [];
    const queue = [...input.calls];

    while (queue.length > 0) {
      if (input.signal?.aborted) {
        throw new ToolBatchAbortedError(
          abortReason(input.signal),
          toolMessages
        );
      }
      const call = queue.shift();
      if (!call) {
        break;
      }

      let result: ToolResult;
      try {
        result = await this.options.toolGateway!.call({
          runId: input.runId,
          name: call.name,
          input: call.input,
          callId: call.id,
          returnErrors: true,
          signal: input.signal
        });
      } catch (error) {
        if (error instanceof ToolPermissionError) {
          if (error.action === 'deny') {
            const deniedContent = `Tool ${call.name} denied by policy: ${error.reason ?? error.message}`;
            toolMessages.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: deniedContent
            });
            continue;
          }

          const session: PendingToolSession = {
            runId: input.runId,
            mode: input.mode,
            originalUserInput: input.originalUserInput,
            call,
            remainingCalls: queue,
            tools: input.tools,
            iteration: input.iteration
          };
          return {
            kind: 'approval',
            completedToolMessages: toolMessages,
            result: await this.createPendingToolApprovalResult(session, error)
          };
        }
        if (isOperationAborted(error, input.signal)) {
          throw new ToolBatchAbortedError(error, toolMessages);
        }
        throw error;
      }

      toolMessages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.content
      });
    }

    return { kind: 'completed', toolMessages };
  }

  async *streamSoftLand(input: {
    runId: string;
    messages: LlmMessage[];
    maxIterations: number;
    iteration: number;
    signal?: AbortSignal;
  }): AsyncIterable<Extract<AgentRunStreamEvent, { type: 'text-delta' }>> {
    if (!this.options.llmClient) {
      yield {
        type: 'text-delta',
        text: formatMaxIterationsNotice(input.maxIterations)
      };
      return;
    }

    let text = '';
    for await (const chunk of this.options.llmClient.stream({
      messages: [
        ...input.messages,
        softLandUserMessage(input.maxIterations, input.iteration)
      ],
      temperature: 0.2,
      signal: input.signal,
      metadata: {
        purpose: 'max-iterations-soft-land',
        maxIterations: input.maxIterations,
        iteration: input.iteration
      }
    })) {
      if (chunk.type === 'text-delta') {
        text += chunk.text;
        yield { type: 'text-delta', text: chunk.text };
      }
    }

    await this.options.record(input.runId, 'llm.soft_land.completed', {
      maxIterations: input.maxIterations,
      iteration: input.iteration,
      textPreview: text.slice(0, 240),
      droppedToolCalls: true
    });

    if (text.trim().length === 0) {
      yield {
        type: 'text-delta',
        text: formatMaxIterationsNotice(input.maxIterations)
      };
    }
  }

  async createMaxToolIterationsResult(
    runId: string,
    mode: AgentMode,
    message: string
  ): Promise<AgentResult> {
    return this.options.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode,
        status: 'completed',
        summary: message || SOFT_LAND_FALLBACK,
        report: {
          changedFiles: [],
          evidence: ['工具调用循环达到上限，已停止继续执行工具并尝试收尾'],
          risks: ['部分计划可能未执行完，可继续对话推进']
        }
      })
    );
  }

  private createStreamingDeps(): StreamingToolLoopDeps {
    if (!this.options.llmClient) {
      throw new Error('llmClient is required for streaming tool loop');
    }
    return {
      llmClient: this.options.llmClient,
      toolGateway: this.options.toolGateway,
      maxToolIterations: this.options.maxToolIterations,
      record: (runId, type, payload) =>
        this.options.record(runId, type, payload),
      executeToolBatch: (input) => this.executeToolBatch(input),
      streamSoftLand: (input) => this.streamSoftLand(input),
      attachChangedFiles: (result) => this.options.attachChangedFiles(result),
      toLlmTools,
      onContextMaintained: this.options.onContextMaintained,
      onInterrupted: (runId) => {
        this.pendingToolSessions.delete(runId);
      }
    };
  }

  private async executeApprovedToolCall(
    session: PendingToolSession,
    signal?: AbortSignal
  ): Promise<LlmMessage> {
    const result = await this.options.toolGateway!.call({
      runId: session.runId,
      name: session.call.name,
      input: session.call.input,
      callId: session.call.id,
      approved: true,
      returnErrors: true,
      signal
    });

    return {
      role: 'tool',
      toolCallId: session.call.id,
      name: session.call.name,
      content: result.content
    };
  }

  private async createRejectedToolMessage(
    session: PendingToolSession
  ): Promise<LlmMessage> {
    const content = `Tool ${session.call.name} rejected by user.`;
    await this.options.record(session.runId, 'tool_call.rejected', {
      toolName: session.call.name,
      toolCallId: session.call.id,
      input: session.call.input
    });

    return {
      role: 'tool',
      toolCallId: session.call.id,
      name: session.call.name,
      content
    };
  }

  private async createPendingToolApprovalResult(
    session: PendingToolSession,
    error: ToolPermissionError
  ): Promise<AgentResult> {
    const metadata = session.tools?.find(
      (tool) => tool.name === session.call.name
    );
    const pendingApproval: PendingToolApproval = {
      runId: session.runId,
      toolCallId: session.call.id,
      toolName: session.call.name,
      risk: metadata?.risk ?? error.risk,
      reason: error.reason,
      inputPreview: formatToolInputPreview(
        session.call.name,
        session.call.input,
        500
      )
    };
    this.pendingToolSessions.set(session.runId, session);

    return this.options.attachChangedFiles(
      agentResultSchema.parse({
        runId: session.runId,
        mode: session.mode,
        status: 'approval-required',
        summary: `需要确认工具调用：${session.call.name}`,
        pendingApproval,
        report: {
          changedFiles: [],
          evidence: ['模型请求了需要用户确认的工具调用'],
          risks: [`${pendingApproval.risk} tool requires approval`]
        }
      })
    );
  }

  private appendToolMessages(messages: LlmMessage[], iteration: number): void {
    for (const message of messages) {
      if (message.role === 'tool') {
        this.options.sessionContext.appendToolResult({
          toolCallId: message.toolCallId,
          name: message.name,
          content: message.content,
          iteration
        });
      }
    }
  }

  private async finishInterruptedRun(
    session: PendingToolSession,
    reason: string,
    stage: CancellationStage
  ): Promise<AgentResult> {
    if (this.options.sessionContext.getThread().getOpenTurnId()) {
      this.options.interruptTurn('用户中断了当前任务');
    }
    const cancelled = await this.options.attachChangedFiles(
      agentResultSchema.parse({
        runId: session.runId,
        mode: session.mode,
        status: 'cancelled',
        cancellationReason: 'user-interrupt',
        summary: '已中断当前任务',
        report: {
          changedFiles: [],
          evidence: [`用户在 ${stage} 阶段中断运行`],
          risks: []
        }
      })
    );
    await this.options.record(session.runId, 'run.interrupted', {
      reason,
      stage
    });
    await this.options.record(session.runId, 'run.completed', { ...cancelled });
    return cancelled;
  }

  private async finishPendingApprovalCancellation(
    session: PendingToolSession,
    reason: string,
    cancellationReason: 'user-interrupt' | 'system'
  ): Promise<AgentResult> {
    const summary =
      cancellationReason === 'user-interrupt'
        ? '已中断当前任务'
        : `工具调用等待审批时运行已取消：${reason}`;
    const pendingCalls = [session.call, ...session.remainingCalls];
    for (const call of pendingCalls) {
      const content = `Tool ${call.name} cancelled before execution: ${reason}`;
      this.options.sessionContext.appendToolResult({
        toolCallId: call.id,
        name: call.name,
        content,
        iteration: session.iteration
      });
      await this.options.record(session.runId, 'tool_call.cancelled', {
        toolName: call.name,
        callId: call.id,
        status: 'cancelled',
        message: reason,
        summary: 'cancelled before execution'
      });
    }

    const cancelled = await this.options.attachChangedFiles(
      agentResultSchema.parse({
        runId: session.runId,
        mode: session.mode,
        status: 'cancelled',
        cancellationReason,
        summary,
        report: {
          changedFiles: [],
          evidence: ['运行因审批未决被取消'],
          risks: []
        }
      })
    );
    await this.options.record(session.runId, 'run.interrupted', {
      reason,
      stage: 'approval'
    });
    await this.options.record(session.runId, 'run.completed', {
      ...cancelled,
      reason
    });
    this.options.appendAssistantForCancel(cancelled.summary);
    this.options.commitTurn();
    return cancelled;
  }
}

function softLandUserMessage(
  maxIterations: number,
  iteration: number
): LlmMessage {
  return {
    role: 'user',
    content: [
      `【系统】工具调用已达上限 ${maxIterations} 轮（当前尝试第 ${iteration} 轮）。`,
      '请停止调用任何工具，用简洁中文总结：',
      '1. 已完成的工作与关键发现',
      '2. 尚未完成的事项',
      '3. 建议用户下一步怎么做',
      '不要再发起 tool_calls。'
    ].join('\n')
  };
}
