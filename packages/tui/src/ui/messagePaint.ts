/**
 * 消息行缓冲绘制（阶段 2）
 *
 * 思路对齐 pi 的 string[] 行缓冲 + Claude Code 的虚拟视口：
 * - 消息先 paint 成 PaintRow[]（每行是带样式的 segments，已 bake）
 * - 视口只挂载可见行，不再为每条消息重建 Markdown React 树
 * - 工具卡片仍 embed 为 MessageLine（交互复杂）
 * - MessagePaintCache 按 fingerprint+columns 缓存 paint 结果
 */

import {
  countWrappedRows,
  estimateMessageRows,
  layoutFingerprint,
  previewThinkingLines
} from './messageLayout';
import {
  parseMarkdownStreaming,
  type MdLine,
  type MdSpan
} from './markdownParse';
import {
  isThinkingCollapsible,
  type ChatMessage
} from './MessageLine';
import { symbols, theme } from './theme';

export type PaintSegment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  color?: string;
  inverse?: boolean;
};

/** 视口中的一个绘制单元：一行文本，或一张工具卡 */
export type PaintItem =
  | {
      kind: 'line';
      key: string;
      segments: PaintSegment[];
      /** 终端折行后占用行数 */
      height: number;
    }
  | {
      kind: 'tool';
      key: string;
      message: ChatMessage;
      height: number;
    };

export interface PaintWindow {
  items: PaintItem[];
  maxScrollOffset: number;
  totalRows: number;
  hasMoreAbove: boolean;
  hasMoreBelow: boolean;
}

type CacheEntry = {
  fingerprint: string;
  columns: number;
  items: PaintItem[];
  totalHeight: number;
};

/**
 * 消息 → PaintItem[] 缓存。滚动时 messages/columns 不变则直接复用。
 */
export class MessagePaintCache {
  private readonly entries = new Map<number, CacheEntry>();
  private columns = 0;

  clear(): void {
    this.entries.clear();
    this.columns = 0;
  }

  /** 单条消息 paint（带缓存） */
  paintMessage(
    message: ChatMessage,
    columns: number,
    streaming = false
  ): PaintItem[] {
    const width = Math.max(20, columns);
    if (width !== this.columns) {
      this.entries.clear();
      this.columns = width;
    }

    const fingerprint =
      layoutFingerprint(message) + (streaming ? '\u0001s' : '\u0001d');
    const hit = this.entries.get(message.id);
    // 流式中不缓存最终结果（每帧变），但仍可走增量 parse
    if (!streaming && hit && hit.fingerprint === fingerprint && hit.columns === width) {
      return hit.items;
    }

    const items = paintMessageUncached(message, width, streaming);
    const totalHeight = items.reduce((sum, item) => sum + item.height, 0);

    if (!streaming) {
      this.entries.set(message.id, {
        fingerprint,
        columns: width,
        items,
        totalHeight
      });
    } else {
      // 流式：缓存半成品便于同行高估算，fingerprint 含 streaming 标记会在结束时失效
      this.entries.set(message.id, {
        fingerprint,
        columns: width,
        items,
        totalHeight
      });
    }

    return items;
  }

  totalHeight(
    message: ChatMessage,
    columns: number,
    streaming = false
  ): number {
    const items = this.paintMessage(message, columns, streaming);
    return items.reduce((sum, item) => sum + item.height, 0);
  }
}

/**
 * 将消息列表 paint 后按视觉行窗口化。
 * 部分可见时按行切片（样式在 segment 里，不丢 MD 格式）。
 */
export function windowPaintRows(input: {
  messages: ChatMessage[];
  columns: number;
  viewportRows: number;
  scrollOffset: number;
  streamingMessageId?: number;
  paintCache?: MessagePaintCache;
}): PaintWindow {
  const {
    messages,
    columns,
    streamingMessageId,
    paintCache = new MessagePaintCache()
  } = input;
  const viewportRows = Math.max(1, input.viewportRows);
  const width = Math.max(20, columns);

  // 展平所有 paint items，记录全局行区间
  type Flat = { item: PaintItem; start: number; end: number };
  const flat: Flat[] = [];
  let cursor = 0;

  for (const message of messages) {
    const streaming = streamingMessageId === message.id;
    const items = paintCache.paintMessage(message, width, streaming);
    for (const item of items) {
      const start = cursor;
      const end = cursor + item.height;
      flat.push({ item, start, end });
      cursor = end;
    }
  }

  const totalRows = cursor;
  const maxScrollOffset = Math.max(0, totalRows - viewportRows);
  const scrollOffset = Math.min(
    Math.max(0, input.scrollOffset),
    maxScrollOffset
  );
  const endLine = totalRows - scrollOffset;
  const startLine = Math.max(0, endLine - viewportRows);

  if (flat.length === 0) {
    return {
      items: [],
      maxScrollOffset: 0,
      totalRows: 0,
      hasMoreAbove: false,
      hasMoreBelow: false
    };
  }

  const visible: PaintItem[] = [];
  for (const { item, start, end } of flat) {
    if (end <= startLine || start >= endLine) {
      continue;
    }

    // 工具卡：整块带上（避免半卡）
    if (item.kind === 'tool') {
      visible.push(item);
      continue;
    }

    // 行高 >1（折行）且部分可见：整行带上，避免切断
    if (item.height === 1 || (start >= startLine && end <= endLine)) {
      visible.push(item);
      continue;
    }

    // 折行块部分可见仍整行保留（与 messageLayout 策略一致）
    visible.push(item);
  }

  return {
    items: visible,
    maxScrollOffset,
    totalRows,
    hasMoreAbove: startLine > 0,
    hasMoreBelow: scrollOffset > 0
  };
}

function paintMessageUncached(
  message: ChatMessage,
  columns: number,
  streaming: boolean
): PaintItem[] {
  if (message.from === 'tool' && message.tool) {
    const height = estimateMessageRows(message, columns);
    return [
      {
        kind: 'tool',
        key: `tool-${message.id}`,
        message,
        height
      }
    ];
  }

  if (message.from === 'system') {
    return [
      lineItem(
        `sys-${message.id}`,
        [
          {
            text: `${symbols.systemPrefix} ${message.text}`,
            dim: true
          }
        ],
        columns
      ),
      blankItem(`sys-gap-${message.id}`)
    ];
  }

  if (message.from === 'user') {
    const body = message.text.replace(/^\>\s*/, '');
    return [
      lineItem(
        `user-${message.id}`,
        [
          { text: `${symbols.userLabel}  `, dim: true },
          { text: body, color: theme.user }
        ],
        columns
      ),
      blankItem(`user-gap-${message.id}`)
    ];
  }

  if (message.from === 'thinking') {
    return paintThinking(message, columns, streaming);
  }

  // agent
  return paintAgent(message, columns, streaming);
}

function paintAgent(
  message: ChatMessage,
  columns: number,
  streaming: boolean
): PaintItem[] {
  const items: PaintItem[] = [];
  const time = formatTime(message.createdAt);
  const headerSegs: PaintSegment[] = [
    { text: symbols.agentLabel, bold: true, color: theme.agent }
  ];
  if (time) {
    headerSegs.push({ text: `  ${time}`, dim: true });
  }
  items.push(lineItem(`agent-h-${message.id}`, headerSegs, columns));

  const mdLines = message.viewportLines
    ? message.viewportLines
    : parseMarkdownStreaming(
        message.text,
        `msg-${message.id}`,
        streaming
      );

  const bodyWidth = Math.max(1, columns - 2);
  for (let i = 0; i < mdLines.length; i++) {
    const md = mdLines[i];
    if (!md) continue;
    const segs = mdLineToSegments(md, true);
    const isLast = i === mdLines.length - 1;
    if (streaming && isLast) {
      // 光标由 Viewport 的 pulse 追加；这里留空占位逻辑在组件层
    }
    items.push(
      lineItem(`agent-${message.id}-L${i}`, segs, bodyWidth + 2, bodyWidth)
    );
  }

  items.push(blankItem(`agent-gap-${message.id}`));
  return items;
}

function paintThinking(
  message: ChatMessage,
  columns: number,
  streaming: boolean
): PaintItem[] {
  const items: PaintItem[] = [];
  const expanded = message.expanded === true || streaming;
  const time = formatTime(message.createdAt);
  const header: PaintSegment[] = [{ text: 'thinking', dim: true }];
  if (streaming) {
    header.push({ text: '  reasoning', color: theme.statusBusy });
  }
  if (time) {
    header.push({ text: `  ${time}`, dim: true });
  }
  items.push(lineItem(`th-h-${message.id}`, header, columns));

  const { visibleLines, hiddenCount } = previewThinkingLines(
    message.text,
    expanded
  );
  const bodyWidth = Math.max(1, columns - 2);
  for (let i = 0; i < visibleLines.length; i++) {
    items.push(
      lineItem(
        `th-${message.id}-L${i}`,
        [
          { text: `${symbols.messageRail} `, dim: true, color: theme.brandMuted },
          { text: visibleLines[i] ?? '', dim: true }
        ],
        columns,
        bodyWidth + 2
      )
    );
  }

  if (!expanded && !streaming && hiddenCount > 0) {
    const totalLines =
      message.text.length === 0 ? 1 : message.text.split('\n').length;
    items.push(
      lineItem(
        `th-fold-${message.id}`,
        [
          { text: `${symbols.messageRail} `, dim: true },
          {
            text: `${symbols.collapseMark} 已折叠 thinking${
              totalLines > 1 ? ` ${hiddenCount}/${totalLines} 行` : ''
            } · ctrl+o 展开`,
            dim: true
          }
        ],
        columns
      )
    );
  } else if (
    expanded &&
    !streaming &&
    isThinkingCollapsible(message.text)
  ) {
    items.push(
      lineItem(
        `th-exp-${message.id}`,
        [
          { text: `${symbols.messageRail} `, dim: true },
          {
            text: `${symbols.collapseMark} thinking 已展开 · ctrl+o 折叠`,
            dim: true
          }
        ],
        columns
      )
    );
  }

  items.push(blankItem(`th-gap-${message.id}`));
  return items;
}

function mdLineToSegments(line: MdLine, rail: boolean): PaintSegment[] {
  const segs: PaintSegment[] = [];
  if (rail) {
    segs.push({
      text: `${symbols.messageRail} `,
      color: theme.brandMuted,
      dim: true
    });
  }
  if (line.kind === 'blank') {
    segs.push({ text: ' ' });
    return segs;
  }

  const headingColor =
    line.kind === 'heading'
      ? line.level === 1
        ? theme.brand
        : line.level === 2
          ? theme.brandSoft
          : undefined
      : undefined;

  for (const span of line.spans) {
    segs.push(spanToSegment(span, line, headingColor));
  }
  if (segs.length === (rail ? 1 : 0)) {
    segs.push({ text: ' ' });
  }
  return segs;
}

function spanToSegment(
  span: MdSpan,
  line: MdLine,
  headingColor?: string
): PaintSegment {
  return {
    text: span.text,
    bold: span.bold || line.kind === 'heading',
    italic: span.italic,
    dim: span.dim,
    color: span.color ?? headingColor,
    inverse: span.inverse
  };
}

function lineItem(
  key: string,
  segments: PaintSegment[],
  columns: number,
  wrapColumns?: number
): PaintItem {
  const plain = segments.map((s) => s.text).join('');
  const height = countWrappedRows(plain, wrapColumns ?? columns);
  return { kind: 'line', key, segments, height };
}

function blankItem(key: string): PaintItem {
  return {
    kind: 'line',
    key,
    segments: [{ text: ' ' }],
    height: 1
  };
}

function formatTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

/** 测试辅助：可见纯文本 */
export function paintItemPlainText(item: PaintItem): string {
  if (item.kind === 'tool') {
    return `[tool:${item.message.tool?.name ?? '?'}]`;
  }
  return item.segments.map((s) => s.text).join('');
}
