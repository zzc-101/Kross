import {
  agentResultSchema,
  type AgentMode,
  type AgentResult
} from '../domain';
import type { BuildContextInput, SessionContext } from '../context/sessionContext';
import type { LlmClient, LlmMessage, LlmToolCall } from '../llm/types';
import type { ToolGateway, ToolMetadata } from '../tools/toolGateway';
import type { AgentRunStreamEvent } from './agentRuntimeTypes';
import type { LlmToolDefinition } from '../llm/types';

export const DEFAULT_MAX_TOOL_ITERATIONS = 200;

const SOFT_LAND_FALLBACK =
  '已达到工具调用轮次上限。请查看上文工具结果；如需继续，请再发一条指令推进剩余工作。';

export function formatMaxIterationsNotice(maxIterations: number): string {
  return `${SOFT_LAND_FALLBACK}（上限 ${maxIterations} 轮）`;
}

export { SOFT_LAND_FALLBACK };

export type ToolBatchOutcome =
  | { kind: 'completed'; toolMessages: LlmMessage[] }
  | { kind: 'approval'; result: AgentResult; completedToolMessages: LlmMessage[] };

export type LlmStreamPurpose = 'planner' | 'planner-tool-followup';

export interface StreamingToolLoopHandlers {
  onSuccess(input: {
    fullText: string;
    fullThinking: string;
  }): Promise<AgentResult>;
  onSoftLand(input: {
    summary: string;
    fullText: string;
    fullThinking: string;
  }): Promise<AgentResult>;
  onFailure(message: string): Promise<AgentResult>;
}

export interface StreamingToolLoopParams {
  runId: string;
  mode: Exclude<AgentMode, 'auto'>;
  /** 本轮 run 的用户原始输入；审批挂起/续跑时沿用同一值 */
  originalUserInput: string;
  sessionContext: SessionContext;
  buildContextInput: BuildContextInput;
  tools: ToolMetadata[];
  startIteration: number;
  /** 首轮 stream 的 purpose；后续轮次固定为 planner-tool-followup */
  firstStreamPurpose: LlmStreamPurpose;
  /** 仅合并到 startIteration 那一轮 stream metadata */
  firstIterationMetadata?: Record<string, unknown>;
  /** 合并到每一轮 stream metadata */
  streamMetadata?: Record<string, unknown>;
  handlers: StreamingToolLoopHandlers;
  /** llm.planner.failed 的替代事件名（审批续跑路径不写 planner.failed） */
  failureEventType?: string;
}

export interface StreamingToolLoopDeps {
  llmClient: LlmClient;
  toolGateway?: ToolGateway;
  maxToolIterations?: number;
  record(
    runId: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<void>;
  executeToolBatch(input: {
    runId: string;
    mode: Exclude<AgentMode, 'auto'>;
    originalUserInput: string;
    calls: LlmToolCall[];
    tools: ToolMetadata[];
    iteration: number;
  }): Promise<ToolBatchOutcome>;
  streamSoftLand(input: {
    runId: string;
    messages: LlmMessage[];
    maxIterations: number;
    iteration: number;
  }): AsyncIterable<Extract<AgentRunStreamEvent, { type: 'text-delta' }>>;
  attachChangedFiles(result: AgentResult): Promise<AgentResult>;
  toLlmTools(tools: ToolMetadata[]): LlmToolDefinition[] | undefined;
  onContextMaintained?(
    runId: string,
    maintenance: import('../context/contextGovernor').ContextMaintenanceResult[]
  ): Promise<void>;
}

/**
 * 共享的工具调用循环：每轮从 SessionContext.prepareRequest 取消息；
 * assistant / tool 结果写入 Thread，不再局部累积 messages。
 */
export async function* runStreamingToolLoop(
  deps: StreamingToolLoopDeps,
  params: StreamingToolLoopParams
): AsyncIterable<AgentRunStreamEvent> {
  const maxIterations = deps.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const { sessionContext, buildContextInput } = params;
  let iteration = params.startIteration;
  let fullText = '';
  let fullThinking = '';

  try {
    while (true) {
      sessionContext.setIteration(iteration);
      const prepared = await sessionContext.prepareRequest(buildContextInput);
      const messages = prepared.messages;
      if (deps.onContextMaintained && prepared.maintenance.length > 0) {
        await deps.onContextMaintained(params.runId, prepared.maintenance);
      }

      let turnText = '';
      let turnThinking = '';
      const toolCalls: LlmToolCall[] = [];

      yield { type: 'turn-start', iteration };

      const isFirstIteration = iteration === params.startIteration;
      const purpose = isFirstIteration
        ? params.firstStreamPurpose
        : 'planner-tool-followup';

      for await (const chunk of deps.llmClient.stream({
        messages,
        tools: deps.toLlmTools(params.tools),
        temperature: 0.2,
        metadata: {
          purpose,
          iteration,
          ...(params.streamMetadata ?? {}),
          ...(isFirstIteration ? (params.firstIterationMetadata ?? {}) : {})
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

      sessionContext.calibrateFromUsage(
        deps.llmClient.lastUsage?.inputTokens,
        messages
      );

      const completedEventType =
        purpose === 'planner'
          ? 'llm.planner.completed'
          : 'llm.tool_followup.completed';

      await deps.record(params.runId, completedEventType, {
        provider: deps.llmClient.provider,
        model: 'stream',
        textPreview: turnText.slice(0, 240),
        thinkingPreview: turnThinking.slice(0, 240) || undefined,
        toolCallCount: toolCalls.length,
        ...(purpose === 'planner' ? {} : { iteration })
      });

      if (toolCalls.length > 0 && iteration > maxIterations) {
        await deps.record(params.runId, 'llm.tool_loop.max_iterations', {
          maxIterations,
          iteration,
          pendingToolCallCount: toolCalls.length,
          calls: toolCalls.map((call) => ({ id: call.id, name: call.name })),
          softLand: true
        });

        yield { type: 'turn-start', iteration };
        let softText = '';
        for await (const chunk of deps.streamSoftLand({
          runId: params.runId,
          messages,
          maxIterations,
          iteration
        })) {
          if (chunk.type === 'text-delta') {
            softText += chunk.text;
            fullText =
              fullText.length > 0 ? `${fullText}\n\n${chunk.text}` : chunk.text;
            yield chunk;
          }
        }

        const summary =
          softText.trim() ||
          fullText.trim() ||
          formatMaxIterationsNotice(maxIterations);
        const landed = await params.handlers.onSoftLand({
          summary,
          fullText,
          fullThinking
        });
        yield { type: 'result', result: landed };
        return;
      }

      if (toolCalls.length === 0 || !deps.toolGateway) {
        if (turnText.trim().length > 0) {
          sessionContext.appendAssistant(turnText);
        }
        break;
      }

      yield {
        type: 'tools-start',
        iteration,
        count: toolCalls.length
      };

      await deps.record(params.runId, 'llm.tool_calls.received', {
        count: toolCalls.length,
        iteration,
        calls: toolCalls.map((call) => ({ id: call.id, name: call.name }))
      });

      sessionContext.appendAssistant(turnText, toolCalls);

      const batch = await deps.executeToolBatch({
        runId: params.runId,
        mode: params.mode,
        originalUserInput: params.originalUserInput,
        calls: toolCalls,
        tools: params.tools,
        iteration
      });

      const completedTools =
        batch.kind === 'completed'
          ? batch.toolMessages
          : batch.completedToolMessages;
      for (const toolMessage of completedTools) {
        if (toolMessage.role === 'tool') {
          sessionContext.appendToolResult({
            toolCallId: toolMessage.toolCallId,
            name: toolMessage.name,
            content: toolMessage.content,
            iteration
          });
        }
      }

      if (batch.kind === 'approval') {
        const approval = await deps.attachChangedFiles(batch.result);
        await deps.record(params.runId, 'run.awaiting_approval', {
          pendingApproval: approval.pendingApproval
        });
        yield { type: 'result', result: approval };
        return;
      }

      iteration += 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureEventType = params.failureEventType ?? 'llm.planner.failed';
    await deps.record(params.runId, failureEventType, { message });
    const failed = await params.handlers.onFailure(message);
    yield { type: 'result', result: failed };
    return;
  }

  const result = await params.handlers.onSuccess({ fullText, fullThinking });
  yield { type: 'result', result };
}

/** 缺 LLM 时审批续跑路径的快速失败结果 */
export function createMissingLlmAfterApprovalResult(
  runId: string,
  mode: Exclude<AgentMode, 'auto'>
): AgentResult {
  return agentResultSchema.parse({
    runId,
    mode,
    status: 'failed',
    summary: '工具审批后无法继续：未配置 LLM',
    report: {
      changedFiles: [],
      evidence: ['tool approval resolved without llmClient'],
      risks: ['请配置模型后重试']
    }
  });
}
