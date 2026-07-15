import type { SessionContext } from '../context/sessionContext';
import {
  agentResultSchema,
  type AgentMode,
  type AgentResult,
  type PendingToolApproval
} from '../domain';
import type {
  LlmClient,
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition
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
  type StreamingToolLoopDeps,
  type StreamingToolLoopParams,
  type ToolBatchOutcome
} from './streamingToolLoop';

const SOFT_LAND_FALLBACK =
  '已达到工具调用轮次上限。请查看上文工具结果；如需继续，请再发一条指令推进剩余工作。';

export {
  DEFAULT_MAX_TOOL_ITERATIONS,
  formatMaxIterationsNotice
} from './streamingToolLoop';

export const PLANNER_SYSTEM_PROMPT =
  '你是本地 agent 的规划器。请基于模式和用户目标给出简短、可执行的计划。需要工具时，只能基于可用工具清单提出调用意图，不要编造工具。';

interface PendingToolSession {
  runId: string;
  mode: Exclude<AgentMode, 'auto'>;
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
      const summary = `工具调用等待审批时运行已取消：${reasonText}`;
      const cancelled = await this.options.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode: session.mode,
          status: 'cancelled',
          summary,
          report: {
            changedFiles: [],
            evidence: ['运行因审批未决被取消'],
            risks: []
          }
        })
      );
      await this.options.record(runId, 'run.completed', {
        ...cancelled,
        reason: reasonText
      });
      this.options.appendAssistantForCancel(cancelled.summary);
      this.options.commitTurn();
      cancelledRunIds.push(runId);
    }

    return cancelledRunIds;
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

    const toolMessage = input.approved
      ? await this.executeApprovedToolCall(session)
      : await this.createRejectedToolMessage(session);

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
      iteration: session.iteration
    });
    if (batch.kind === 'approval') {
      const approval = await this.options.attachChangedFiles(batch.result);
      await this.options.record(session.runId, 'run.awaiting_approval', {
        pendingApproval: approval.pendingApproval
      });
      yield { type: 'result', result: approval };
      return;
    }

    for (const msg of batch.kind === 'completed' ? batch.toolMessages : []) {
      if (msg.role === 'tool') {
        this.options.sessionContext.appendToolResult({
          toolCallId: msg.toolCallId,
          name: msg.name,
          content: msg.content,
          iteration: session.iteration
        });
      }
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
        }
      }
    });
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
    mode: Exclude<AgentMode, 'auto'>;
    originalUserInput: string;
    calls: LlmToolCall[];
    tools: ToolMetadata[];
    iteration: number;
  }): Promise<ToolBatchOutcome> {
    const toolMessages: LlmMessage[] = [];
    const queue = [...input.calls];

    while (queue.length > 0) {
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
          returnErrors: true
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
    mode: Exclude<AgentMode, 'auto'>,
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
      onContextMaintained: this.options.onContextMaintained
    };
  }

  private async executeApprovedToolCall(
    session: PendingToolSession
  ): Promise<LlmMessage> {
    const result = await this.options.toolGateway!.call({
      runId: session.runId,
      name: session.call.name,
      input: session.call.input,
      callId: session.call.id,
      approved: true,
      returnErrors: true
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
}

export function toLlmTools(
  tools: ToolMetadata[]
): LlmToolDefinition[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
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
