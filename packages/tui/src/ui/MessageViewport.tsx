import React, { useEffect, useMemo, useRef } from 'react';
import { Box, Text } from 'ink';

import { MessageLine, type ChatMessage } from './MessageLine';
import {
  MessagePaintCache,
  windowPaintRows,
  type PaintItem,
  type PaintSegment
} from './messagePaint';
import { symbols, theme } from './theme';
import { usePulse } from './usePulse';

/**
 * 全屏中间消息视口（阶段 2：行缓冲绘制）
 *
 * - 全屏：消息 paint 成行 → 只挂载可见 PaintItem（O(视口行) React 节点）
 * - 非全屏/测试：退回 MessageLine 列表（最多 80 条）
 * - scrollOffset=0 贴底；增大则向上翻历史
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
  const hasTip = Boolean(tip);
  const [hasMoreAboveState, setHasMoreAbove] = React.useState(false);
  const [hasMoreBelowState, setHasMoreBelow] = React.useState(false);

  const viewportRows = height && height > 0 ? height : undefined;
  const indicatorRows =
    (hasTip ? 2 : 0) +
    (hasMoreAboveState ? 1 : 0) +
    (hasMoreBelowState ? 1 : 0);

  const paintCacheRef = useRef(new MessagePaintCache());
  const cursor = usePulse(
    symbols.cursorFrames,
    420,
    streamingMessageId !== undefined
  );

  const windowed = useMemo(() => {
    if (viewportRows === undefined) {
      return null;
    }
    return windowPaintRows({
      messages,
      columns,
      viewportRows: Math.max(1, viewportRows - indicatorRows),
      scrollOffset,
      streamingMessageId,
      paintCache: paintCacheRef.current
    });
  }, [
    messages,
    columns,
    viewportRows,
    scrollOffset,
    indicatorRows,
    streamingMessageId
  ]);

  useEffect(() => {
    if (!windowed) {
      setHasMoreAbove(false);
      setHasMoreBelow(false);
      return;
    }
    setHasMoreAbove(windowed.hasMoreAbove);
    setHasMoreBelow(windowed.hasMoreBelow);
  }, [windowed?.hasMoreAbove, windowed?.hasMoreBelow]);

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
            <Text dimColor>tip · {tip}</Text>
          </Box>
        ) : null}
        {messages.length > capped.length ? (
          <Text dimColor> ↑ 更早消息已省略</Text>
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

  const body = (
    <Box flexDirection="column">
      {tip ? (
        <Box marginBottom={1}>
          <Text dimColor>tip · {tip}</Text>
        </Box>
      ) : null}
      {windowed.hasMoreAbove ? (
        <Text dimColor> ↑ 更早消息 · 滚轮/触摸板 或 PgUp</Text>
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
      {windowed.hasMoreBelow ? (
        <Text dimColor> ↓ 已离开底部 · PgDn 回到最新</Text>
      ) : null}
    </Box>
  );

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
  if (item.kind === 'tool') {
    return (
      <MessageLine
        message={item.message}
        streaming={streamingMessageId === item.message.id}
      />
    );
  }

  const showCursor =
    isLastVisible &&
    streamingMessageId !== undefined &&
    // 流式消息最后一行：key 含 agent-{id}
    item.key.includes(`agent-${streamingMessageId}-`);

  return (
    <Text>
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
  inverse?: boolean;
} {
  return {
    bold: seg.bold,
    italic: seg.italic,
    dimColor: seg.dim,
    color: seg.color,
    inverse: seg.inverse
  };
}
