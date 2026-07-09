import { parseMarkdown, displayWidth } from './markdownParse';
import {
  THINKING_COLLAPSE_CHAR_LIMIT,
  THINKING_COLLAPSE_LINE_LIMIT
} from './theme';
import { isThinkingCollapsible } from './MessageLine';
import type { ChatMessage } from './MessageLine';

/**
 * 消息行高缓存：scroll 时 messages/columns 大多不变，避免反复 parseMarkdown。
 * fingerprint 变化（流式追加、展开折叠）会自动失效单条缓存。
 */
export class MessageRowHeightCache {
  private columns = 0;
  private readonly entries = new Map<
    number,
    { fingerprint: string; rows: number }
  >();

  clear(): void {
    this.entries.clear();
    this.columns = 0;
  }

  estimate(message: ChatMessage, columns: number): number {
    const width = Math.max(20, columns);
    if (width !== this.columns) {
      this.entries.clear();
      this.columns = width;
    }

    const fingerprint = layoutFingerprint(message);
    const hit = this.entries.get(message.id);
    if (hit && hit.fingerprint === fingerprint) {
      return hit.rows;
    }

    const rows = estimateMessageRows(message, width);
    this.entries.set(message.id, { fingerprint, rows });
    return rows;
  }
}

/** 仅包含影响行高的字段，避免滚动时无意义重算。 */
export function layoutFingerprint(message: ChatMessage): string {
  const toolItems = message.tool?.items;
  const toolSig = toolItems
    ? `${toolItems.length}:${toolItems.map((item) => item.status).join(',')}`
    : '';
  const plainLen = message.viewportPlainText?.length ?? -1;
  // 流式内容：长度 + 头尾片段足以区分追加
  const text = message.text;
  const head = text.slice(0, 24);
  const tail = text.length > 24 ? text.slice(-24) : '';
  return [
    message.from,
    message.expanded === true ? '1' : '0',
    String(text.length),
    head,
    tail,
    String(plainLen),
    toolSig
  ].join('\u0001');
}

/**
 * 估算消息在终端中占用的行数（用于视口窗口化，避免全量布局卡死）。
 */
export function estimateMessageRows(
  message: ChatMessage,
  columns: number
): number {
  const width = Math.max(20, columns);

  // 视口已预裁剪为纯文本时，按行计
  if (message.viewportPlainText !== undefined) {
    const lines =
      message.viewportPlainText.length === 0
        ? ['']
        : message.viewportPlainText.split('\n');
    let rows = message.from === 'agent' || message.from === 'thinking' ? 1 : 0;
    for (const line of lines) {
      rows += countWrappedRows(line, width - 2);
    }
    return rows + 1;
  }

  if (message.from === 'tool') {
    const items = message.tool?.items?.length ?? 1;
    return message.expanded === true ? 1 + items : 1;
  }

  if (message.from === 'system') {
    return countWrappedRows(message.text, width) + 1;
  }

  if (message.from === 'user') {
    return countWrappedRows(message.text.replace(/^\>\s*/, ''), width) + 1;
  }

  if (message.from === 'thinking') {
    const expanded = message.expanded === true;
    const { visibleLines } = previewThinkingLines(message.text, expanded);
    let rows = 1;
    for (const line of visibleLines) {
      rows += countWrappedRows(line, width - 2);
    }
    if (!expanded && isThinkingCollapsible(message.text)) {
      rows += 1;
    }
    return rows + 1;
  }

  // agent：按 MD 渲染后的视觉行估算
  return 1 + countVisualRows(message.text, width - 2) + 1;
}

/** 把 MD 渲染成终端可见的纯文本行（表格已展开为 box 字符） */
export function markdownToVisualLines(source: string): string[] {
  return parseMarkdown(source).map((line) =>
    line.spans.map((span) => span.text).join('')
  );
}

function countVisualRows(source: string, columns: number): number {
  const visual = markdownToVisualLines(source);
  let rows = 0;
  for (const line of visual) {
    rows += countWrappedRows(line, columns);
  }
  return Math.max(1, rows);
}

export function countWrappedRows(text: string, columns: number): number {
  if (text.length === 0) {
    return 1;
  }
  const width = Math.max(1, columns);
  // 使用 displayWidth 计算 CJK 双宽字符的占位
  const visualWidth = displayWidth(text);
  return Math.max(1, Math.ceil(visualWidth / width));
}

export function previewThinkingLines(
  text: string,
  expanded: boolean
): { visibleLines: string[]; hiddenCount: number } {
  const lines = text.length === 0 ? [''] : text.split('\n');
  if (expanded || !isThinkingCollapsible(text)) {
    return { visibleLines: lines, hiddenCount: 0 };
  }
  const previewLineCount =
    text.length > THINKING_COLLAPSE_CHAR_LIMIT &&
    lines.length <= THINKING_COLLAPSE_LINE_LIMIT
      ? Math.min(4, lines.length)
      : Math.min(THINKING_COLLAPSE_LINE_LIMIT, lines.length);
  const sliced = lines.slice(0, previewLineCount);
  const maxLineChars = Math.max(
    80,
    Math.floor(THINKING_COLLAPSE_CHAR_LIMIT / Math.max(1, previewLineCount))
  );
  const visibleLines = sliced.map((line) =>
    line.length > maxLineChars ? `${line.slice(0, maxLineChars - 1)}…` : line
  );
  const lineHidden = lines.length - sliced.length;
  const charTruncated = sliced.some((line, i) => line !== visibleLines[i]);
  return {
    visibleLines,
    hiddenCount: lineHidden > 0 ? lineHidden : charTruncated ? 1 : 0
  };
}

export interface ViewportWindow {
  messages: ChatMessage[];
  maxScrollOffset: number;
  totalRows: number;
  hasMoreAbove: boolean;
  hasMoreBelow: boolean;
}

/**
 * 从消息列表中选出落在视口内的子集。
 * scrollOffset=0 贴底；增大则向上翻历史。
 *
 * 关键：对超长 agent 消息按「渲染后视觉行」裁剪，而不是按原始 MD 行，
 * 避免表格被拦腰截断导致表头丢失/边框错乱。
 */
export function windowMessages(input: {
  messages: ChatMessage[];
  columns: number;
  viewportRows: number;
  scrollOffset: number;
  /** 可选行高缓存；滚动帧之间复用，显著降低 MD 解析次数 */
  heightCache?: MessageRowHeightCache;
}): ViewportWindow {
  const { messages, columns, heightCache } = input;
  const viewportRows = Math.max(1, input.viewportRows);
  const heights = messages.map((message) =>
    heightCache
      ? heightCache.estimate(message, columns)
      : estimateMessageRows(message, columns)
  );
  const totalRows = heights.reduce((sum, h) => sum + h, 0);
  const maxScrollOffset = Math.max(0, totalRows - viewportRows);
  const scrollOffset = Math.min(Math.max(0, input.scrollOffset), maxScrollOffset);

  if (messages.length === 0) {
    return {
      messages: [],
      maxScrollOffset: 0,
      totalRows: 0,
      hasMoreAbove: false,
      hasMoreBelow: false
    };
  }

  const endLine = totalRows - scrollOffset;
  const startLine = Math.max(0, endLine - viewportRows);

  const visible: ChatMessage[] = [];
  let cursor = 0;

  for (let i = 0; i < messages.length; i++) {
    const h = heights[i] ?? 1;
    const msgStart = cursor;
    const msgEnd = cursor + h;
    cursor = msgEnd;

    if (msgEnd <= startLine || msgStart >= endLine) {
      continue;
    }

    const message = messages[i];
    if (!message) {
      continue;
    }

    const fullyVisible = msgStart >= startLine && msgEnd <= endLine;
    if (fullyVisible) {
      // 清除可能残留的裁剪标记
      if (message.viewportPlainText !== undefined) {
        const { viewportPlainText: _drop, ...rest } = message;
        visible.push(rest as ChatMessage);
      } else {
        visible.push(message);
      }
      continue;
    }

    // 部分可见：仅对 agent/thinking 做视觉行裁剪
    if (message.from === 'agent' || message.from === 'thinking') {
      const clipped = clipMessageByVisualRows(message, {
        msgStart,
        msgEnd,
        startLine,
        endLine,
        columns
      });
      if (clipped) {
        visible.push(clipped);
      }
    } else {
      // 短消息整条带上
      visible.push(message);
    }
  }

  return {
    messages: visible,
    maxScrollOffset,
    totalRows,
    hasMoreAbove: startLine > 0,
    hasMoreBelow: scrollOffset > 0
  };
}

/**
 * 按渲染后的视觉行裁剪 agent/thinking 消息。
 * 裁剪结果写入 viewportPlainText，展示层不再二次 MD 解析（避免表格被拆碎）。
 */
function clipMessageByVisualRows(
  message: ChatMessage,
  range: {
    msgStart: number;
    msgEnd: number;
    startLine: number;
    endLine: number;
    columns: number;
  }
): ChatMessage | undefined {
  const width = Math.max(20, range.columns - 2);
  const labelRows = 1;
  const bodyStart = range.msgStart + labelRows;

  const visualLines =
    message.from === 'thinking'
      ? previewThinkingLines(message.text, message.expanded === true).visibleLines
      : markdownToVisualLines(message.text);

  // 将视觉行展开为「占位行」列表（考虑折行）
  const expanded: string[] = [];
  for (const line of visualLines) {
    const wraps = countWrappedRows(line, width);
    if (wraps <= 1) {
      expanded.push(line);
    } else {
      // 折行时仍整行保留，避免把表格行从中间切断
      expanded.push(line);
    }
  }

  if (expanded.length === 0) {
    return {
      ...message,
      viewportPlainText: '…'
    };
  }

  // 可见区间映射到 body 视觉行下标
  const visibleBodyStart = Math.max(range.startLine, bodyStart);
  const visibleBodyEnd = Math.min(range.endLine, range.msgEnd);
  const bodyOffset = Math.max(0, visibleBodyStart - bodyStart);
  const bodyLen = Math.max(0, visibleBodyEnd - visibleBodyStart);

  if (bodyLen <= 0) {
    return {
      ...message,
      viewportPlainText: '…'
    };
  }

  // body 行与 expanded 行近似 1:1（折行整行保留）
  let sliceStart = Math.min(bodyOffset, expanded.length);
  let sliceEnd = Math.min(expanded.length, bodyOffset + bodyLen);

  // 贴底时：优先保留消息末尾
  if (range.endLine >= range.msgEnd - 1) {
    const keep = Math.max(1, Math.min(expanded.length, bodyLen));
    sliceStart = Math.max(0, expanded.length - keep);
    sliceEnd = expanded.length;
  }

  // 若裁剪起点落在表格 box 中间，回退到最近的表格顶/底边界
  sliceStart = snapSliceToTableBoundary(expanded, sliceStart, 'start');
  sliceEnd = snapSliceToTableBoundary(expanded, sliceEnd, 'end');

  if (sliceEnd <= sliceStart) {
    sliceStart = Math.max(0, expanded.length - 1);
    sliceEnd = expanded.length;
  }

  const sliced = expanded.slice(sliceStart, sliceEnd);
  if (sliceStart > 0) {
    sliced.unshift('…');
  }
  if (sliceEnd < expanded.length) {
    sliced.push('…');
  }

  return {
    ...message,
    viewportPlainText: sliced.join('\n')
  };
}

/**
 * 避免从表格 box 中间切开：
 * - start：若当前行是表格中部，向上找到 ┌ 或退出表格
 * - end：若当前行是表格中部，向下找到 └ 或退出表格
 */
function snapSliceToTableBoundary(
  lines: string[],
  index: number,
  edge: 'start' | 'end'
): number {
  if (index <= 0 || index >= lines.length) {
    return index;
  }
  const line = lines[index] ?? '';
  if (!isTableBoxLine(line)) {
    return index;
  }
  // 已在顶/底边
  if (line.includes('┌') || line.includes('└')) {
    return index;
  }

  if (edge === 'start') {
    for (let i = index; i >= 0; i--) {
      const l = lines[i] ?? '';
      if (l.includes('┌')) {
        return i;
      }
      if (!isTableBoxLine(l)) {
        return i + 1;
      }
    }
    return 0;
  }

  for (let i = index; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.includes('└')) {
      return i + 1;
    }
    if (!isTableBoxLine(l)) {
      return i;
    }
  }
  return lines.length;
}

function isTableBoxLine(line: string): boolean {
  return /[┌┬┐├┼┤└┴┘│─]/.test(line);
}
