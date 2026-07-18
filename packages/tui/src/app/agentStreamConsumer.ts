import {
  type AgentResult,
  type AgentRunStreamEvent,
  type VerificationReport
} from '@kross/core';

import type { ChatMessage } from '../ui';

export interface AppendMessageOptions {
  expanded?: boolean;
  /** 已完成 thinking 的耗时；提交时直接写入，避免 createdAt=现在导致 0 秒 */
  durationMs?: number;
  /** 结构化的最终验证结论，供 TUI 着色并跨会话恢复。 */
  verification?: VerificationReport;
}

export interface AgentStreamConsumerDeps {
  append: (
    from: ChatMessage['from'],
    text: string,
    options?: AppendMessageOptions
  ) => number;
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
 * 消费 runStreaming / resolveToolApprovalStreaming 的异步事件流。
 *
 * Claude Code 式 thinking：
 * - thinking-delta 只缓冲，底部 waiting 不撤
 * - thinking 结束后再一次性落「Thought for X s」（默认折叠）
 * - text 仍按 delta 流式渲染
 */
export async function consumeAgentStream(
  stream: AsyncIterable<AgentRunStreamEvent>,
  deps: AgentStreamConsumerDeps
): Promise<AgentStreamConsumerResult> {
  let streamedMessageId: number | undefined;
  let streamedText = '';
  let thinkingText = '';
  let thinkingStartedAt: number | undefined;
  let thinkingCommitted = false;
  let sawAgentText = false;
  let result: AgentResult | undefined;

  const commitThinkingIfNeeded = (): void => {
    if (thinkingCommitted || thinkingText.length === 0) {
      return;
    }
    thinkingCommitted = true;
    const durationMs =
      thinkingStartedAt !== undefined
        ? Math.max(0, Date.now() - thinkingStartedAt)
        : 0;
    deps.append('thinking', thinkingText, { durationMs });
  };

  const beginTurn = () => {
    deps.flushMessageUpdates();
    // 上一轮若只剩未封口 thinking（异常路径），先落盘再开新轮
    commitThinkingIfNeeded();
    deps.finalizeThinkingDurations?.();
    streamedMessageId = undefined;
    streamedText = '';
    thinkingText = '';
    thinkingStartedAt = undefined;
    thinkingCommitted = false;
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
      commitThinkingIfNeeded();
      deps.flushMessageUpdates();
      deps.setStreamingMessageId(undefined);
      deps.setAwaitingReply(true);
      deps.setLoadingVariant('tool');
      continue;
    }

    if (event.type === 'thinking-delta') {
      if (thinkingStartedAt === undefined) {
        thinkingStartedAt = Date.now();
      }
      thinkingText += event.text;
      // 保持 awaitingReply=true：底部 waiting 扛「进行中」，不插入流式 thinking 气泡
      deps.setLoadingVariant('thinking');
      continue;
    }

    if (event.type === 'text-delta') {
      commitThinkingIfNeeded();
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

    commitThinkingIfNeeded();
    deps.flushMessageUpdates();
    result = event.result;
    deps.setAwaitingReply(false);
    deps.setStreamingMessageId(undefined);
    deps.finalizeThinkingDurations?.();
  }

  return { result, sawAgentText };
}
