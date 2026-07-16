import { throwIfAborted } from '../abort';
import type { SessionContext } from '../context/sessionContext';
import type { AgentMode } from '../domain';
import type { LlmClient } from '../llm/types';
import type { ToolGateway, ToolMetadata } from '../tools/toolGateway';
import {
  executeSequentialToolCalls,
  toLlmTools,
  toolCallsSignature
} from './toolLoopShared';

export interface CompleteToolLoopParams {
  runId: string;
  prompt: string;
  systemPrompt: string;
  mode?: AgentMode;
  llmClient: LlmClient;
  gateway: ToolGateway;
  tools: ToolMetadata[];
  sessionContext: SessionContext;
  maxIterations: number;
  signal?: AbortSignal;
  /** Default 0.2 (subagent parity). */
  temperature?: number;
  /**
   * Merged into every complete() metadata (with purpose/iteration).
   * Defaults include isSubagent: true for subagent parity.
   */
  streamMetadata?: Record<string, unknown>;
  /** Default 'subagent'. */
  purpose?: string;
  /** Soft-land complete purpose. Default 'subagent-soft-land'. */
  softLandPurpose?: string;
  onTurn?: (info: { iteration: number }) => Promise<void>;
  onCompleted?: (info: {
    iteration: number;
    textPreview: string;
    toolCallCount: number;
  }) => Promise<void>;
  onStalled?: (info: {
    iteration: number;
    signaturePreview: string;
  }) => Promise<void>;
}

const DEFAULT_EMPTY_SUMMARY = 'Subagent finished without a text summary.';
const DEFAULT_STALL_SUMMARY =
  'Subagent stopped: repeated the same tool calls without progress.';
const SOFT_LAND_USER_MESSAGE =
  'Tool iteration limit reached. Summarize findings and remaining work for the parent agent. Do not call tools.';

/**
 * Non-streaming complete()-based tool loop (subagent path).
 * Main agent continues to use runStreamingToolLoop (stream + approval).
 *
 * Semantics (parity with historical runSubagentToolLoop):
 * - beginTurn → prepareRequest → complete @ temperature 0.2
 * - stall when the same tool signature repeats twice in a row after first match
 *   (repeatedSignatureCount >= 2 → third consecutive identical batch)
 * - soft-land user message when max iterations exhausted
 */
export async function runCompleteToolLoop(
  params: CompleteToolLoopParams
): Promise<string> {
  const temperature = params.temperature ?? 0.2;
  const purpose = params.purpose ?? 'subagent';
  const softLandPurpose = params.softLandPurpose ?? 'subagent-soft-land';
  const baseMetadata = {
    isSubagent: true,
    ...(params.streamMetadata ?? {})
  };
  const mode = params.mode ?? 'auto';

  params.sessionContext.beginTurn(params.prompt);
  const buildContextInput = {
    systemPrompt: params.systemPrompt,
    mode,
    tools: params.tools
  };

  let iteration = 1;
  let lastText = '';
  /** 连续「相同工具签名」次数；用于打断模型空转死循环 */
  let repeatedSignatureCount = 0;
  let lastToolSignature = '';

  while (iteration <= params.maxIterations) {
    throwIfAborted(params.signal);
    params.sessionContext.setIteration(iteration);

    await params.onTurn?.({ iteration });

    const prepared = await params.sessionContext.prepareRequest(
      buildContextInput,
      params.signal
    );
    throwIfAborted(params.signal);
    const response = await params.llmClient.complete({
      messages: prepared.messages,
      tools: toLlmTools(params.tools),
      temperature,
      signal: params.signal,
      metadata: {
        ...baseMetadata,
        purpose,
        iteration
      }
    });
    throwIfAborted(params.signal);
    params.sessionContext.calibrateFromUsage(
      response.usage?.inputTokens,
      prepared.messages
    );

    lastText = response.text?.trim() ?? '';

    await params.onCompleted?.({
      iteration,
      textPreview: lastText.slice(0, 240),
      toolCallCount: response.toolCalls?.length ?? 0
    });

    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) {
      if (lastText) {
        params.sessionContext.appendAssistant(lastText);
      }
      params.sessionContext.commitTurn();
      return lastText || DEFAULT_EMPTY_SUMMARY;
    }

    const signature = toolCallsSignature(toolCalls);
    if (signature === lastToolSignature) {
      repeatedSignatureCount += 1;
    } else {
      repeatedSignatureCount = 0;
      lastToolSignature = signature;
    }
    // 同一组工具调用连打 3 轮 → 视为空转，强制收束
    if (repeatedSignatureCount >= 2) {
      await params.onStalled?.({
        iteration,
        signaturePreview: signature.slice(0, 240)
      });
      const stallSummary = lastText || DEFAULT_STALL_SUMMARY;
      params.sessionContext.appendAssistant(stallSummary);
      params.sessionContext.commitTurn();
      return stallSummary;
    }

    params.sessionContext.appendAssistant(response.text ?? '', toolCalls);
    const toolMessages = await executeSequentialToolCalls({
      runId: params.runId,
      gateway: params.gateway,
      calls: toolCalls,
      signal: params.signal
    });
    throwIfAborted(params.signal);
    for (const toolMessage of toolMessages) {
      if (toolMessage.role === 'tool') {
        params.sessionContext.appendToolResult({
          toolCallId: toolMessage.toolCallId,
          name: toolMessage.name,
          content: toolMessage.content,
          iteration
        });
      }
    }
    iteration += 1;
  }

  throwIfAborted(params.signal);
  const prepared = await params.sessionContext.prepareRequest(
    buildContextInput,
    params.signal
  );
  const soft = await params.llmClient.complete({
    messages: [
      ...prepared.messages,
      {
        role: 'user',
        content: SOFT_LAND_USER_MESSAGE
      }
    ],
    temperature,
    signal: params.signal,
    metadata: {
      ...baseMetadata,
      purpose: softLandPurpose
    }
  });
  const summary =
    soft.text?.trim() ||
    lastText ||
    `Subagent reached tool iteration limit (${params.maxIterations}).`;
  params.sessionContext.appendAssistant(summary);
  params.sessionContext.commitTurn();
  return summary;
}
