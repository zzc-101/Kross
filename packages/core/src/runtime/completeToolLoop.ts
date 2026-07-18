import { throwIfAborted } from '../abort';
import type { SessionContext } from '../context/sessionContext';
import type { AgentMode } from '../domain';
import type { LlmClient } from '../llm/types';
import { renderPrompt } from '../prompts';
import type { ToolGateway, ToolMetadata } from '../tools/toolGateway';
import {
  executeSequentialToolCalls,
  toLlmTools
} from './toolLoopShared';
import { ToolLoopStallDetector } from './toolLoopStallDetector';

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
    fingerprint: string;
    repeatedCount: number;
  }) => Promise<void>;
  onStallRecovery?: (info: {
    iteration: number;
    signaturePreview: string;
    fingerprint: string;
    repeatedCount: number;
  }) => Promise<void>;
}

/**
 * Non-streaming complete()-based tool loop (subagent path).
 * Main agent continues to use runStreamingToolLoop (stream + approval).
 *
 * Semantics (parity with historical runSubagentToolLoop):
 * - beginTurn → prepareRequest → complete @ temperature 0.2
 * - recover once when the same tool batch and results repeat without progress
 * - stall if the unchanged observation repeats again after recovery
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
  let stallRecoveryPending = false;
  const stallDetector = new ToolLoopStallDetector();

  while (iteration <= params.maxIterations) {
    throwIfAborted(params.signal);
    params.sessionContext.setIteration(iteration);

    await params.onTurn?.({ iteration });

    const prepared = await params.sessionContext.prepareRequest(
      stallRecoveryPending
        ? {
            ...buildContextInput,
            systemPrompt: `${buildContextInput.systemPrompt}\n${renderPrompt('agent.stall.recovery')}`
          }
        : buildContextInput,
      params.signal
    );
    stallRecoveryPending = false;
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
      return lastText || renderPrompt('subagent.summary.empty');
    }

    params.sessionContext.appendAssistant(response.text ?? '', toolCalls);
    const toolMessages = await executeSequentialToolCalls({
      runId: params.runId,
      gateway: params.gateway,
      calls: toolCalls,
      tools: params.tools,
      iteration,
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
    const stall = stallDetector.observe({ calls: toolCalls, results: toolMessages });
    if (stall.state === 'recover') {
      await params.onStallRecovery?.({ iteration, ...stall });
      stallRecoveryPending = true;
    } else if (stall.state === 'stalled') {
      await params.onStalled?.({ iteration, ...stall });
      const stallSummary = renderPrompt('subagent.summary.stalled');
      params.sessionContext.appendAssistant(stallSummary);
      params.sessionContext.commitTurn();
      return stallSummary;
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
        content: renderPrompt('subagent.softLand.user')
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
