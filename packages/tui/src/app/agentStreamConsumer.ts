import { type AgentResult, type AgentRunStreamEvent } from '@kross/core';

import type { ChatMessage } from '../ui';

export interface AgentStreamConsumerDeps {
  append: (from: ChatMessage['from'], text: string) => number;
  enqueueMessageUpdate: (id: number, text: string) => void;
  flushMessageUpdates: () => void;
  finalizeThinkingDurations?: () => void;
  setAwaitingReply: (value: boolean) => void;
  setLoadingVariant: (variant: 'thinking' | 'tool') => void;
  setStreamingMessageId: (id: number | undefined) => void;
}

export interface AgentStreamConsumerResult {
  result?: AgentResult;
  sawAgentText: boolean;
}

/**
 * 消费 runStreaming / resolveToolApprovalStreaming 的异步事件流，
 * 将 text-delta / thinking-delta 写入消息列表。
 */
export async function consumeAgentStream(
  stream: AsyncIterable<AgentRunStreamEvent>,
  deps: AgentStreamConsumerDeps
): Promise<AgentStreamConsumerResult> {
  let streamedMessageId: number | undefined;
  let thinkingMessageId: number | undefined;
  let streamedText = '';
  let thinkingText = '';
  let sawAgentText = false;
  let result: AgentResult | undefined;

  const beginTurn = () => {
    deps.flushMessageUpdates();
    deps.finalizeThinkingDurations?.();
    // 每轮 LLM 迭代新开气泡，避免 tool 后的 thinking/text 写回工具前消息
    streamedMessageId = undefined;
    thinkingMessageId = undefined;
    streamedText = '';
    thinkingText = '';
    deps.setStreamingMessageId(undefined);
  };

  for await (const event of stream) {
    if (event.type === 'turn-start') {
      beginTurn();
      deps.setAwaitingReply(true);
      deps.setLoadingVariant('thinking');
      continue;
    }

    if (event.type === 'tools-start') {
      deps.flushMessageUpdates();
      deps.setStreamingMessageId(undefined);
      deps.setAwaitingReply(true);
      deps.setLoadingVariant('tool');
      continue;
    }

    if (event.type === 'thinking-delta') {
      thinkingText += event.text;
      deps.setAwaitingReply(false);
      deps.setLoadingVariant('thinking');
      if (thinkingMessageId === undefined) {
        thinkingMessageId = deps.append('thinking', thinkingText);
        deps.setStreamingMessageId(thinkingMessageId);
      } else {
        deps.enqueueMessageUpdate(thinkingMessageId, thinkingText);
      }
      continue;
    }

    if (event.type === 'text-delta') {
      streamedText += event.text;
      sawAgentText = true;
      deps.setAwaitingReply(false);
      if (streamedMessageId === undefined) {
        streamedMessageId = deps.append('agent', streamedText);
        deps.setStreamingMessageId(streamedMessageId);
      } else {
        deps.enqueueMessageUpdate(streamedMessageId, streamedText);
      }
      continue;
    }

    deps.flushMessageUpdates();
    result = event.result;
    deps.setAwaitingReply(false);
    deps.setStreamingMessageId(undefined);
    deps.finalizeThinkingDurations?.();
  }

  return { result, sawAgentText };
}
