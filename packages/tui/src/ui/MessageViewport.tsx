import React, { useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';

import { MessageLine, type ChatMessage } from './MessageLine';
import { windowMessages } from './messageLayout';
import { theme } from './theme';

/**
 * 全屏中间消息视口：只渲染窗口内消息，避免超长历史把 Ink yoga 布局拖死。
 * scrollOffset=0 贴底；增大则向上翻看历史。
 */
export function MessageViewport({
  messages,
  streamingMessageId,
  height,
  columns = 80,
  scrollOffset = 0,
  tip,
  onScrollBounds
}: {
  messages: ChatMessage[];
  streamingMessageId?: number;
  /** 视口可用行数（必须传入全屏模式） */
  height?: number;
  columns?: number;
  scrollOffset?: number;
  tip?: string;
  /** 回传 maxScroll，便于 App 钳制 scrollOffset */
  onScrollBounds?: (bounds: { maxScrollOffset: number; totalRows: number }) => void;
}) {
  const viewportRows = height && height > 0 ? height : undefined;

  const windowed = useMemo(() => {
    if (viewportRows === undefined) {
      // 测试/非全屏：仍限制最大渲染条数，防止意外爆量
      const capped =
        messages.length > 80 ? messages.slice(messages.length - 80) : messages;
      return {
        messages: capped,
        maxScrollOffset: 0,
        totalRows: 0,
        hasMoreAbove: messages.length > capped.length,
        hasMoreBelow: false
      };
    }
    return windowMessages({
      messages,
      columns,
      viewportRows: Math.max(1, viewportRows - (tip ? 2 : 0)),
      scrollOffset
    });
  }, [messages, columns, viewportRows, scrollOffset, tip]);

  useEffect(() => {
    if (!onScrollBounds || viewportRows === undefined) {
      return;
    }
    onScrollBounds({
      maxScrollOffset: windowed.maxScrollOffset,
      totalRows: windowed.totalRows
    });
  }, [onScrollBounds, viewportRows, windowed.maxScrollOffset, windowed.totalRows]);

  const body = (
    <Box flexDirection="column">
      {tip ? (
        <Box marginBottom={1}>
          <Text dimColor>tip · {tip}</Text>
        </Box>
      ) : null}
      {windowed.hasMoreAbove ? (
        <Text dimColor color={theme.chip}>
          ↑ 更早消息 · 滚轮/触摸板 或 PgUp
        </Text>
      ) : null}
      {windowed.messages.map((message) => (
        <MessageLine
          key={message.id}
          message={message}
          streaming={streamingMessageId === message.id}
        />
      ))}
      {windowed.hasMoreBelow ? (
        <Text dimColor color={theme.chip}>
          ↓ 已离开底部 · PgDn 回到最新
        </Text>
      ) : null}
    </Box>
  );

  if (viewportRows === undefined) {
    return body;
  }

  return (
    <Box
      flexDirection="column"
      height={viewportRows}
      overflowY="hidden"
      justifyContent="flex-end"
    >
      {body}
    </Box>
  );
}
