import type { ContextManager } from '../context/contextManager';
import {
  agentResultSchema,
  type AgentMode,
  type AgentResult,
  type PendingToolApproval
} from '../domain';
import type {
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  LlmToolDefinition
} from '../llm/types';
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

export const DEFAULT_MAX_TOOL_ITERATIONS = 200;

const SOFT_LAND_FALLBACK =
  '已达到工具调用轮次上限。请查看上文工具结果；如需继续，请再发一条指令推进剩余工作。';

export const PLANNER_SYSTEM_PROMPT =
  '你是本地 agent 的规划器。请基于模式和用户目标给出简短、可执行的计划。需要工具时，只能基于可用工具清单提出调用意图，不要编造工具。';

export type PlannerOutcome =
  | { kind: 'response'; response: LlmResponse }
  | { kind: 'approval'; result: AgentResult }
  | { kind: 'max-iterations'; message: string }
  | { kind: 'failure'; message: string }
  | undefined;

type ToolLoopOutcome =
  | { kind: 'response'; response: LlmResponse }
  | { kind: 'approval'; result: AgentResult }
  | { kind: 'max-iterations'; message: string };

export type ToolBatchOutcome =
  | { kind: 'completed'; toolMessages: LlmMessage[] }
  | { kind: 'approval'; result: AgentResult };

interface PendingToolSession {
  runId: string;
  mode: Exclude<AgentMode, 'auto'>;
  call: LlmToolCall;
  remainingCalls: LlmToolCall[];
  completedToolMessages: LlmMessage[];
  messages: LlmMessage[];
  tools: ToolMetadata[];
  iteration: number;
}

export interface RuntimeToolLoopOptions {
  llmClient?: LlmClient;
  toolGateway?: ToolGateway;
  contextManager: ContextManager;
  maxToolIterations?: number;
  record(
    runId: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<void>;
  attachChangedFiles(result: AgentResult): Promise<AgentResult>;
  appendConversation(userInput: string, assistantOutput: string): void;
}

export class RuntimeToolLoop {
  private readonly pendingToolSessions = new Map<string, PendingToolSession>();

  constructor(private readonly options: RuntimeToolLoopOptions) {}

  setLlmClient(client: LlmClient | undefined): void {
    this.options.llmClient = client;
  }

  async resolveToolApproval(
    input: ResolveToolApprovalInput
  ): Promise<AgentResult> {
    const session = this.pendingToolSessions.get(input.runId);
    if (!session) {
      throw new Error(`No pending tool approval for run: ${input.runId}`);
    }
    this.pendingToolSessions.delete(input.runId);

    const toolMessage = input.approved
      ? await this.executeApprovedToolCall(session)
      : await this.createRejectedToolMessage(session);

    const batch = await this.executeToolBatch({
      runId: session.runId,
      mode: session.mode,
      calls: session.remainingCalls,
      completedToolMessages: [...session.completedToolMessages, toolMessage],
      messages: session.messages,
      tools: session.tools,
      iteration: session.iteration
    });
    if (batch.kind === 'approval') {
      const approval = await this.options.attachChangedFiles(batch.result);
      await this.options.record(session.runId, 'run.awaiting_approval', {
        pendingApproval: approval.pendingApproval
      });
      return approval;
    }

    const messages: LlmMessage[] = [...session.messages, ...batch.toolMessages];
    const response = await this.completeToolFollowup({
      runId: session.runId,
      messages,
      tools: session.tools,
      iteration: session.iteration,
      metadata: { approvalResolved: input.approved }
    });
    const outcome = await this.runToolLoop({
      runId: session.runId,
      mode: session.mode,
      response,
      messages,
      tools: session.tools,
      iteration: session.iteration + 1
    });
    if (outcome.kind === 'approval') {
      const approval = await this.options.attachChangedFiles(outcome.result);
      await this.options.record(session.runId, 'run.awaiting_approval', {
        pendingApproval: approval.pendingApproval
      });
      return approval;
    }
    if (outcome.kind === 'max-iterations') {
      const failed = await this.createMaxToolIterationsResult(
        session.runId,
        session.mode,
        outcome.message
      );
      await this.options.record(session.runId, 'run.completed', { ...failed });
      this.options.appendConversation('[tool approval]', failed.summary);
      return failed;
    }

    const result = await this.options.attachChangedFiles(
      agentResultSchema.parse({
        runId: session.runId,
        mode: session.mode,
        status: 'completed',
        summary: outcome.response.text,
        thinking: outcome.response.thinking || undefined,
        report: {
          changedFiles: [],
          evidence: ['工具审批已处理，planner LLM 已返回最终回复'],
          risks: []
        }
      })
    );

    await this.options.record(session.runId, 'run.completed', { ...result });
    this.options.appendConversation('[tool approval]', result.summary);
    return result;
  }

  async createPlannerSuggestion(
    runId: string,
    goal: string,
    mode: Exclude<AgentMode, 'auto'>
  ): Promise<PlannerOutcome> {
    if (!this.options.llmClient) {
      return undefined;
    }

    try {
      const availableTools = this.options.toolGateway?.listTools({ mode }) ?? [];
      const context = this.options.contextManager.build({
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        currentUserInput: goal,
        mode,
        tools: availableTools
      });

      await this.options.record(runId, 'context.built', {
        includedSources: context.includedSources,
        droppedSources: context.droppedSources,
        estimatedChars: context.estimatedChars,
        report: context.report
      });

      const response = await this.options.llmClient.complete({
        messages: context.messages,
        tools: toLlmTools(availableTools),
        temperature: 0.2,
        metadata: {
          purpose: 'planner',
          includedSources: context.includedSources,
          droppedSources: context.droppedSources,
          contextReport: context.report
        }
      });

      await this.options.record(runId, 'llm.planner.completed', {
        provider: response.provider,
        model: response.model,
        textPreview: response.text.slice(0, 240),
        thinkingPreview: response.thinking?.slice(0, 240),
        usage: response.usage,
        toolCallCount: response.toolCalls?.length ?? 0
      });

      if (response.toolCalls?.length && this.options.toolGateway) {
        return this.runToolLoop({
          runId,
          mode,
          response,
          messages: context.messages,
          tools: availableTools,
          iteration: 1
        });
      }

      return { kind: 'response', response };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.record(runId, 'llm.planner.failed', { message });
      return { kind: 'failure', message };
    }
  }

  async executeToolBatch(input: {
    runId: string;
    mode: Exclude<AgentMode, 'auto'>;
    calls: LlmToolCall[];
    completedToolMessages: LlmMessage[];
    messages: LlmMessage[];
    tools: ToolMetadata[];
    iteration: number;
  }): Promise<ToolBatchOutcome> {
    const toolMessages: LlmMessage[] = [...input.completedToolMessages];
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
            this.options.contextManager.recordToolResult({
              id: call.id,
              toolName: call.name,
              inputPreview: JSON.stringify(call.input).slice(0, 200),
              output: deniedContent,
              summary: `denied: ${error.reason ?? error.risk}`
            });
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
            call,
            remainingCalls: queue,
            completedToolMessages: toolMessages,
            messages: input.messages,
            tools: input.tools,
            iteration: input.iteration
          };
          return {
            kind: 'approval',
            result: await this.createPendingToolApprovalResult(session, error)
          };
        }
        throw error;
      }

      this.options.contextManager.recordToolResult({
        id: call.id,
        toolName: call.name,
        inputPreview: JSON.stringify(call.input).slice(0, 200),
        output: result.content,
        summary: result.summary
      });
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

  private async runToolLoop(input: {
    runId: string;
    mode: Exclude<AgentMode, 'auto'>;
    response: LlmResponse;
    messages: LlmMessage[];
    tools: ToolMetadata[];
    iteration: number;
  }): Promise<ToolLoopOutcome> {
    const maxIterations =
      this.options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    let response = input.response;
    let messages = input.messages;
    let iteration = input.iteration;

    while (response.toolCalls?.length && iteration <= maxIterations) {
      await this.options.record(input.runId, 'llm.tool_calls.received', {
        count: response.toolCalls.length,
        iteration,
        calls: response.toolCalls.map((call) => ({
          id: call.id,
          name: call.name
        }))
      });

      const assistantMessage: LlmMessage = {
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls
      };
      const batchMessages: LlmMessage[] = [...messages, assistantMessage];
      const batch = await this.executeToolBatch({
        runId: input.runId,
        mode: input.mode,
        calls: response.toolCalls,
        completedToolMessages: [],
        messages: batchMessages,
        tools: input.tools,
        iteration
      });
      if (batch.kind === 'approval') {
        return batch;
      }

      messages = [...batchMessages, ...batch.toolMessages];
      response = await this.completeToolFollowup({
        runId: input.runId,
        messages,
        tools: input.tools,
        iteration
      });
      iteration += 1;
    }

    if (response.toolCalls?.length) {
      await this.options.record(
        input.runId,
        'llm.tool_loop.max_iterations',
        {
          maxIterations,
          iteration,
          pendingToolCallCount: response.toolCalls.length,
          calls: response.toolCalls.map((call) => ({
            id: call.id,
            name: call.name
          })),
          softLand: true
        }
      );
      const soft = await this.completeSoftLand({
        runId: input.runId,
        messages,
        maxIterations,
        iteration
      });
      return { kind: 'response', response: soft };
    }

    return { kind: 'response', response };
  }

  private async completeSoftLand(input: {
    runId: string;
    messages: LlmMessage[];
    maxIterations: number;
    iteration: number;
  }): Promise<LlmResponse> {
    if (!this.options.llmClient) {
      return {
        provider: 'openai',
        model: 'none',
        text: formatMaxIterationsNotice(input.maxIterations),
        raw: {}
      };
    }

    const response = await this.options.llmClient.complete({
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
    });

    await this.options.record(input.runId, 'llm.soft_land.completed', {
      maxIterations: input.maxIterations,
      iteration: input.iteration,
      textPreview: response.text.slice(0, 240),
      droppedToolCalls: true
    });

    const text =
      response.text.trim() || formatMaxIterationsNotice(input.maxIterations);
    return { ...response, text, toolCalls: undefined };
  }

  private async completeToolFollowup(input: {
    runId: string;
    messages: LlmMessage[];
    tools: ToolMetadata[];
    iteration: number;
    metadata?: Record<string, unknown>;
  }): Promise<LlmResponse> {
    const response = await this.options.llmClient!.complete({
      messages: input.messages,
      tools: toLlmTools(input.tools),
      temperature: 0.2,
      metadata: {
        purpose: 'planner-tool-followup',
        iteration: input.iteration,
        ...input.metadata
      }
    });

    await this.options.record(input.runId, 'llm.tool_followup.completed', {
      provider: response.provider,
      model: response.model,
      textPreview: response.text.slice(0, 240),
      thinkingPreview: response.thinking?.slice(0, 240),
      usage: response.usage,
      toolCallCount: response.toolCalls?.length ?? 0,
      iteration: input.iteration
    });

    return response;
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
    this.options.contextManager.recordToolResult({
      id: session.call.id,
      toolName: session.call.name,
      inputPreview: JSON.stringify(session.call.input).slice(0, 200),
      output: result.content,
      summary: result.summary
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
    this.options.contextManager.recordToolResult({
      id: session.call.id,
      toolName: session.call.name,
      inputPreview: JSON.stringify(session.call.input).slice(0, 200),
      output: content,
      summary: 'rejected by user'
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
    const metadata = session.tools.find(
      (tool) => tool.name === session.call.name
    );
    const pendingApproval: PendingToolApproval = {
      runId: session.runId,
      toolCallId: session.call.id,
      toolName: session.call.name,
      risk: metadata?.risk ?? error.risk,
      reason: error.reason,
      inputPreview: JSON.stringify(session.call.input).slice(0, 500)
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

export function formatMaxIterationsNotice(maxIterations: number): string {
  return `${SOFT_LAND_FALLBACK}（上限 ${maxIterations} 轮）`;
}
