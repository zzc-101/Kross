import React, { useEffect, useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import { t } from '@kross/core';

import { MessageLine, type ChatMessage } from './MessageLine';
import {
  buildPaintLayout,
  MessagePaintCache,
  resolveViewportContentRows,
  windowPaintLayout,
  type PaintItem,
  type PaintSegment
} from './messagePaint';
import { symbols, theme } from './theme';
import { usePulse } from './usePulse';

/**
 * 全屏中间消息视口（阶段 2：行缓冲绘制）
 *
 * - 全屏：消息（含工具）一律 paint 成行 → 只挂载可见行
 * - 滚动提示：底部居中一行悬浮，不占上下消息流
 * - 非全屏/测试：退回 MessageLine 列表
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
  onScrollBounds?: (bounds: {
    maxScrollOffset: number;
    totalRows: number;
  }) => void;
}) {
  const viewportRows = height && height > 0 ? height : undefined;

  const paintCacheRef = useRef(new MessagePaintCache());
  const cursor = usePulse(
    symbols.cursorFrames,
    420,
    streamingMessageId !== undefined
  );
  const thinkingClock = messages.some(
    (message) =>
      message.id === streamingMessageId && message.from === 'thinking'
  )
    ? cursor
    : undefined;

  const layout = useMemo(() => {
    if (viewportRows === undefined) {
      return null;
    }
    return buildPaintLayout({
      messages,
      columns,
      streamingMessageId,
      paintCache: paintCacheRef.current,
      nowMs: Date.now()
    });
  }, [messages, columns, viewportRows, streamingMessageId, thinkingClock]);

  const { contentRows, scrollHint } = useMemo(() => {
    if (viewportRows === undefined) {
      return { contentRows: undefined as number | undefined, scrollHint: null };
    }
    const resolved = resolveViewportContentRows({
      messages,
      columns,
      viewportRows,
      scrollOffset,
      streamingMessageId,
      paintCache: paintCacheRef.current
    });
    return {
      contentRows: resolved.contentRows,
      scrollHint: resolved.scrollHint
    };
  }, [messages, columns, viewportRows, scrollOffset, streamingMessageId, layout]);

  const windowed = useMemo(() => {
    if (!layout || contentRows === undefined) {
      return null;
    }
    return windowPaintLayout({
      layout,
      viewportRows: contentRows,
      scrollOffset
    });
  }, [layout, contentRows, scrollOffset]);

  useEffect(() => {
    if (!onScrollBounds || !windowed || viewportRows === undefined) {
      return;
    }
    onScrollBounds({
      maxScrollOffset: windowed.maxScrollOffset,
      totalRows: windowed.totalRows
    });
  }, [
    onScrollBounds,
    viewportRows,
    windowed?.maxScrollOffset,
    windowed?.totalRows
  ]);

  // 非全屏：文档流 MessageLine（测试 / 无 TTY 尺寸）
  if (viewportRows === undefined || !windowed) {
    const capped =
      messages.length > 80 ? messages.slice(messages.length - 80) : messages;
    return (
      <Box flexDirection="column">
        {tip ? (
          <Box marginBottom={1}>
            <Text dimColor>{t('common.tip')} · {tip}</Text>
          </Box>
        ) : null}
        {messages.length > capped.length ? (
          <Text dimColor> {t('scroll.olderOmitted')}</Text>
        ) : null}
        {capped.map((message) => (
          <MessageLine
            key={message.id}
            message={message}
            streaming={streamingMessageId === message.id}
          />
        ))}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      height={viewportRows}
      overflowY="hidden"
      width="100%"
    >
      <Box
        flexDirection="column"
        height={contentRows}
        overflowY="hidden"
        justifyContent="flex-end"
        flexGrow={1}
      >
        {tip ? (
          <Box marginBottom={1}>
            <Text dimColor>{t('common.tip')} · {tip}</Text>
          </Box>
        ) : null}
        {windowed.items.map((item, index) => (
          <PaintItemView
            key={item.key}
            item={item}
            streamingMessageId={streamingMessageId}
            cursor={cursor}
            isLastVisible={index === windowed.items.length - 1}
          />
        ))}
      </Box>
      {scrollHint ? (
        <Box height={1} width="100%" justifyContent="center">
          <Text color={theme.scrollHint} bold>
            {scrollHint}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function PaintItemView({
  item,
  streamingMessageId,
  cursor,
  isLastVisible
}: {
  item: PaintItem;
  streamingMessageId?: number;
  cursor: string;
  isLastVisible: boolean;
}) {
  const showCursor =
    isLastVisible &&
    streamingMessageId !== undefined &&
    item.key.includes(`agent-${streamingMessageId}-`);

  return (
    <Text wrap="truncate">
      {item.segments.map((seg, i) => (
        <Text key={i} {...segmentProps(seg)}>
          {seg.text}
        </Text>
      ))}
      {showCursor ? <Text color={theme.brand}>{cursor}</Text> : null}
    </Text>
  );
}

function segmentProps(seg: PaintSegment): {
  bold?: boolean;
  italic?: boolean;
  dimColor?: boolean;
  color?: string;
  backgroundColor?: string;
  inverse?: boolean;
} {
  return {
    bold: seg.bold,
    italic: seg.italic,
    dimColor: seg.dim,
    color: seg.color,
    backgroundColor: seg.backgroundColor,
    inverse: seg.inverse
  };
}
