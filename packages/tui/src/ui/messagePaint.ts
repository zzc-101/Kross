/**
 * 消息行缓冲绘制（阶段 2）
 *
 * 思路对齐 pi 的 string[] 行缓冲 + Claude Code 的虚拟视口：
 * - 消息先 paint 成 PaintRow[]（每行是带样式的 segments，已 bake）
 * - 视口只挂载可见行，不再为每条消息重建 Markdown React 树
 * - 工具也 paint 成行（禁止 embed MessageLine+margin，否则滚动窗口行高与
 *   Ink 实测不一致，flex-end 重绘时会出现消息/tool 之间空洞）
 * - MessagePaintCache 按 fingerprint+columns 缓存 paint 结果
 */

import { t } from '@kross/core';

import {
  countWrappedRows,
  layoutFingerprint
} from './messageLayout';
import {
  displayWidth,
  parseMarkdownStreaming,
  trimTrailingBlankMdLines,
  type MdLine,
  type MdSpan
} from './markdownParse';
import {
  formatThinkingLabel,
  type ChatMessage,
  type ToolCallState
} from './MessageLine';
import {
  ensureToolItems,
  formatLineStatsLabel,
  formatToolTitle,
  resolveLineStats
} from './toolDisplay';
import { symbols, theme } from './theme';
import {
  formatVerificationPresentation,
  verificationToneColor
} from './verificationPresentation';

export type PaintSegment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  color?: string;
  backgroundColor?: string;
  inverse?: boolean;
};

/** 视口中的一个绘制单元：一行文本（含工具摘要行） */
export type PaintItem = {
  kind: 'line';
  key: string;
  segments: PaintSegment[];
  /** 终端折行后占用行数（paint 阶段保证为 1） */
  height: number;
};

export interface PaintWindow {
  items: PaintItem[];
  /** Absolute row of items[0] in the full paint layout. */
  startRow: number;
  maxScrollOffset: number;
  totalRows: number;
  hasMoreAbove: boolean;
  hasMoreBelow: boolean;
}

interface PaintLayoutEntry {
  item: PaintItem;
  start: number;
  end: number;
}

export interface PaintLayout {
  entries: PaintLayoutEntry[];
  totalRows: number;
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
    streaming = false,
    nowMs = Date.now()
  ): PaintItem[] {
    const width = Math.max(20, columns);
    if (width !== this.columns) {
      this.entries.clear();
      this.columns = width;
    }

    const verificationFingerprint = message.verification
      ? `\u0001v:${formatVerificationPresentation(message.verification).text}`
      : '';
    const fingerprint =
      layoutFingerprint(message) +
      verificationFingerprint +
      (streaming ? '\u0001s' : '\u0001d');
    const hit = this.entries.get(message.id);
    // 流式中不缓存最终结果（每帧变），但仍可走增量 parse
    if (!streaming && hit && hit.fingerprint === fingerprint && hit.columns === width) {
      return hit.items;
    }

    const items = paintMessageUncached(message, width, streaming, nowMs);
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
export function buildPaintLayout(input: {
  messages: ChatMessage[];
  columns: number;
  streamingMessageId?: number;
  paintCache?: MessagePaintCache;
  nowMs?: number;
}): PaintLayout {
  const {
    messages,
    columns,
    streamingMessageId,
    paintCache = new MessagePaintCache(),
    nowMs = Date.now()
  } = input;
  const width = Math.max(20, columns);
  const entries: PaintLayoutEntry[] = [];
  let cursor = 0;

  for (const message of messages) {
    const streaming = streamingMessageId === message.id;
    const items = paintCache.paintMessage(message, width, streaming, nowMs);
    for (const item of items) {
      const start = cursor;
      const end = cursor + item.height;
      entries.push({ item, start, end });
      cursor = end;
    }
  }

  return { entries, totalRows: cursor };
}

export function windowPaintLayout(input: {
  layout: PaintLayout;
  viewportRows: number;
  scrollOffset: number;
}): PaintWindow {
  const viewportRows = Math.max(1, input.viewportRows);
  const { entries, totalRows } = input.layout;

  const maxScrollOffset = Math.max(0, totalRows - viewportRows);
  const scrollOffset = Math.min(
    Math.max(0, input.scrollOffset),
    maxScrollOffset
  );
  const endLine = totalRows - scrollOffset;
  const startLine = Math.max(0, endLine - viewportRows);

  if (entries.length === 0) {
    return {
      items: [],
      startRow: 0,
      maxScrollOffset: 0,
      totalRows: 0,
      hasMoreAbove: false,
      hasMoreBelow: false
    };
  }

  const visible: PaintItem[] = [];
  const firstVisible = findFirstVisibleEntry(entries, startLine);
  for (let index = firstVisible; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.start >= endLine) {
      break;
    }
    // 行级 paint：相交即纳入（每项 height=1，不会半卡）
    visible.push(entry.item);
  }

  // 防御 end 对齐 flex-end：若因边界取整多带了行，从顶部丢掉，
  // 保证挂载行数 ≤ viewportRows，避免 Ink 在固定 height 盒子里重排出空洞。
  let used = visible.reduce((sum, item) => sum + item.height, 0);
  while (used > viewportRows && visible.length > 0) {
    const removed = visible.shift();
    used -= removed?.height ?? 0;
  }

  return {
    items: visible,
    startRow: Math.max(0, endLine - visible.length),
    maxScrollOffset,
    totalRows,
    hasMoreAbove: startLine > 0,
    hasMoreBelow: scrollOffset > 0
  };
}

export function windowPaintRows(input: {
  messages: ChatMessage[];
  columns: number;
  viewportRows: number;
  scrollOffset: number;
  streamingMessageId?: number;
  paintCache?: MessagePaintCache;
}): PaintWindow {
  const layout = buildPaintLayout(input);
  return windowPaintLayout({
    layout,
    viewportRows: input.viewportRows,
    scrollOffset: input.scrollOffset
  });
}

/** 滚动提示文案（底部居中悬浮，极简）。 */
export function formatScrollHint(
  hasMoreAbove: boolean,
  hasMoreBelow: boolean
): string | null {
  if (hasMoreAbove && hasMoreBelow) {
    return t('scroll.both');
  }
  if (hasMoreAbove) {
    return t('scroll.up');
  }
  if (hasMoreBelow) {
    return t('scroll.down');
  }
  return null;
}

/**
 * 与 MessageViewport 一致：满高窗口化后是否显示底部 scroll hint，
 * 以及内容区实际可用行数。
 */
export function resolveViewportContentRows(input: {
  messages: ChatMessage[];
  columns: number;
  viewportRows: number;
  scrollOffset: number;
  streamingMessageId?: number;
  paintCache?: MessagePaintCache;
}): { contentRows: number; scrollHint: string | null } {
  const viewportRows = Math.max(1, input.viewportRows);
  const windowed = windowPaintRows({
    ...input,
    viewportRows
  });
  const scrollHint = formatScrollHint(
    windowed.hasMoreAbove,
    windowed.hasMoreBelow
  );
  return {
    contentRows: Math.max(1, viewportRows - (scrollHint ? 1 : 0)),
    scrollHint
  };
}

export type ClickableMessageHit =
  | { kind: 'thinking'; messageId: number }
  | { kind: 'tool'; messageId: number };

/**
 * 将终端点击行映射到可展开消息（thinking / tool）。
 * 坐标系：clickRow / viewportTopRow 均为终端 1-based 行号。
 */
export function hitTestClickableMessage(input: {
  messages: ChatMessage[];
  columns: number;
  /** 消息内容区可用行数（不含底部 scroll hint 行） */
  contentRows: number;
  scrollOffset: number;
  clickRow: number;
  viewportTopRow: number;
  streamingMessageId?: number;
  paintCache?: MessagePaintCache;
}): ClickableMessageHit | undefined {
  const contentRows = Math.max(1, input.contentRows);
  if (
    input.clickRow < input.viewportTopRow ||
    input.clickRow >= input.viewportTopRow + contentRows
  ) {
    return undefined;
  }

  const windowed = windowPaintRows({
    messages: input.messages,
    columns: input.columns,
    viewportRows: contentRows,
    scrollOffset: input.scrollOffset,
    streamingMessageId: input.streamingMessageId,
    paintCache: input.paintCache
  });

  const contentHeight = windowed.items.reduce(
    (sum, item) => sum + item.height,
    0
  );
  const padTop = Math.max(0, contentRows - contentHeight);
  const contentTopRow = input.viewportTopRow + padTop;
  const localRow = input.clickRow - contentTopRow;
  if (localRow < 0 || localRow >= contentHeight) {
    return undefined;
  }

  let cursor = 0;
  for (const item of windowed.items) {
    if (localRow >= cursor && localRow < cursor + item.height) {
      return clickableHitFromPaintKey(item.key);
    }
    cursor += item.height;
  }
  return undefined;
}

/** @deprecated 使用 hitTestClickableMessage */
export function hitTestThinkingMessageId(input: {
  messages: ChatMessage[];
  columns: number;
  contentRows: number;
  scrollOffset: number;
  clickRow: number;
  viewportTopRow: number;
  streamingMessageId?: number;
  paintCache?: MessagePaintCache;
}): number | undefined {
  const hit = hitTestClickableMessage(input);
  return hit?.kind === 'thinking' ? hit.messageId : undefined;
}

/** paint key → thinking message id；非 thinking 行返回 undefined */
export function thinkingMessageIdFromPaintKey(key: string): number | undefined {
  const hit = clickableHitFromPaintKey(key);
  return hit?.kind === 'thinking' ? hit.messageId : undefined;
}

export function clickableHitFromPaintKey(
  key: string
): ClickableMessageHit | undefined {
  const thHeader = /^th-h-(\d+)/.exec(key);
  if (thHeader) {
    return { kind: 'thinking', messageId: Number(thHeader[1]) };
  }
  const thGap = /^th-gap-(\d+)/.exec(key);
  if (thGap) {
    return { kind: 'thinking', messageId: Number(thGap[1]) };
  }
  const thBody = /^th-(\d+)-/.exec(key);
  if (thBody) {
    return { kind: 'thinking', messageId: Number(thBody[1]) };
  }

  // tool-123-title-W0 / tool-123-detail-0 / tool-gap-123
  const toolTitle = /^tool-(\d+)-title/.exec(key);
  if (toolTitle) {
    return { kind: 'tool', messageId: Number(toolTitle[1]) };
  }
  const toolDetail = /^tool-(\d+)-detail/.exec(key);
  if (toolDetail) {
    return { kind: 'tool', messageId: Number(toolDetail[1]) };
  }
  const toolGap = /^tool-gap-(\d+)/.exec(key);
  if (toolGap) {
    return { kind: 'tool', messageId: Number(toolGap[1]) };
  }
  const toolItem = /^tool-(\d+)-item-/.exec(key);
  if (toolItem) {
    return { kind: 'tool', messageId: Number(toolItem[1]) };
  }
  return undefined;
}

function findFirstVisibleEntry(
  entries: PaintLayoutEntry[],
  startLine: number
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const entry = entries[middle];
    if (entry && entry.end <= startLine) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function paintMessageUncached(
  message: ChatMessage,
  columns: number,
  streaming: boolean,
  nowMs: number
): PaintItem[] {
  if (message.from === 'tool' && message.tool) {
    return paintTool(message, columns);
  }

  if (message.from === 'system') {
    if (message.verification) {
      const presentation = formatVerificationPresentation(message.verification);
      return [
        ...softWrapLineItems(
          `verify-${message.id}`,
          [
            {
              text: presentation.text,
              color: verificationToneColor(message.verification.status, {
                success: theme.statusReady,
                warning: theme.statusWarn,
                error: theme.statusError,
                muted: theme.system
              })
            }
          ],
          columns
        ),
        blankItem(`verify-gap-${message.id}`)
      ];
    }
    return [
      ...softWrapLineItems(
        `sys-${message.id}`,
        [{ text: `${symbols.systemPrefix} ${message.text}`, dim: true }],
        columns
      ),
      blankItem(`sys-gap-${message.id}`)
    ];
  }

  if (message.from === 'user') {
    // 用户历史输入：整行高亮，便于快速区分人与模型的内容。
    const body = message.text.replace(/^\>\s*/, '');
    const prefix = `${symbols.userPrefix} `;
    const prefixWidth = displayWidth(prefix);
    const bodyWidth = Math.max(1, columns - prefixWidth);
    const wrappedBody = wrapPaintSegments(
      [{ text: body, color: theme.user, bold: true }],
      bodyWidth
    );
    const items: PaintItem[] = [];
    for (let i = 0; i < wrappedBody.length; i++) {
      const line = wrappedBody[i] ?? [];
      items.push({
        kind: 'line',
        key: `user-${message.id}-W${i}`,
        segments:
          i === 0
            ? [{ text: prefix, color: theme.user, bold: true }, ...line]
            : [{ text: ' '.repeat(prefixWidth), color: theme.user }, ...line],
        height: 1
      });
    }
    items.push(blankItem(`user-gap-${message.id}`));
    return items;
  }

  if (message.from === 'thinking') {
    return paintThinking(message, columns, streaming, nowMs);
  }

  // agent
  return paintAgent(message, columns, streaming);
}

/**
 * 工具 → 纯 paint 行（与 agent 相同路径）。
 * 展开时按工具类型渲染 detailLines（Edit/Write 红绿 diff）。
 */
function paintTool(message: ChatMessage, columns: number): PaintItem[] {
  const tool = message.tool as ToolCallState;
  const expanded = message.expanded === true;
  const items = ensureToolItems(tool);
  const out: PaintItem[] = [];
  const width = Math.max(1, columns);

  const titleSegs = buildToolTitleSegments(tool, expanded, items.length > 1);
  const wrappedTitle = wrapPaintSegments(titleSegs, width);
  for (let w = 0; w < wrappedTitle.length; w++) {
    out.push({
      kind: 'line',
      key: `tool-${message.id}-title-W${w}`,
      segments: wrappedTitle[w] ?? [{ text: ' ' }],
      height: 1
    });
  }

  if (expanded) {
    // 聚合多文件：始终列路径（detail 只反映最后一次 completed，不适合整组）
    if (items.length > 1) {
      items.forEach((item, index) => {
        const segs: PaintSegment[] = [
          { text: `  ${symbols.systemPrefix} `, dim: true },
          {
            text: item.path ?? item.preview ?? item.summary ?? tool.name,
            dim: true
          }
        ];
        if (
          item.status === 'failed' ||
          item.status === 'denied' ||
          item.status === 'cancelled'
        ) {
          segs.push({
            text: `  ${item.status}`,
            color:
              item.status === 'cancelled'
                ? theme.statusWarn
                : theme.statusError
          });
        }
        out.push({
          kind: 'line',
          key: `tool-${message.id}-item-${index}`,
          segments: segs,
          height: 1
        });
      });
    } else {
      const detail = tool.detailLines ?? [];
      detail.forEach((line, index) => {
        const prefix = '  ';
        const bodyWidth = Math.max(1, width - prefix.length);
        const colored = detailLineSegments(line);
        const wrapped = wrapPaintSegments(colored, bodyWidth);
        for (let w = 0; w < wrapped.length; w++) {
          out.push({
            kind: 'line',
            key: `tool-${message.id}-detail-${index}-W${w}`,
            segments: [
              { text: prefix, dim: true },
              ...(wrapped[w] ?? [{ text: ' ' }])
            ],
            height: 1
          });
        }
      });
      if (tool.detailTruncated) {
        out.push({
          kind: 'line',
          key: `tool-${message.id}-detail-trunc`,
          segments: [{ text: '  … truncated', dim: true }],
          height: 1
        });
      }
    }
  }

  out.push(blankItem(`tool-gap-${message.id}`));
  return out;
}

/**
 * 渲染 diff 行：左侧 gutter（行号 + 标记）与正文分离。
 * 正文 text 原样拼接，不做任何裁剪/改写。
 */
function detailLineSegments(line: {
  text: string;
  op?: 'add' | 'del' | 'meta' | 'ctx';
  lineNo?: number;
}): PaintSegment[] {
  const gutter = formatDiffGutter(line.op, line.lineNo);

  if (line.op === 'add') {
    return [
      {
        text: `${gutter}${line.text}`,
        color: theme.diffOnBg,
        backgroundColor: theme.diffAddBg
      }
    ];
  }
  if (line.op === 'del') {
    return [
      {
        text: `${gutter}${line.text}`,
        color: theme.diffOnBg,
        backgroundColor: theme.diffDelBg
      }
    ];
  }
  if (line.op === 'ctx') {
    return [{ text: `${gutter}${line.text}`, dim: true }];
  }
  return [{ text: line.text, dim: true }];
}

/** 行号 + 标记；正文不经此函数处理 */
function formatDiffGutter(
  op: 'add' | 'del' | 'meta' | 'ctx' | undefined,
  lineNo: number | undefined
): string {
  const num =
    typeof lineNo === 'number' && Number.isFinite(lineNo) && lineNo >= 1
      ? String(Math.floor(lineNo)).padStart(4, ' ')
      : '    ';
  if (op === 'add') {
    return `${num} + `;
  }
  if (op === 'del') {
    return `${num} - `;
  }
  if (op === 'ctx') {
    return `${num}   `;
  }
  return '';
}

function buildToolTitleSegments(
  tool: ToolCallState,
  expanded: boolean,
  multiItem: boolean
): PaintSegment[] {
  const segs: PaintSegment[] = [];
  const canExpand = ensureToolItems(tool).length > 0;
  // 小实心方块（展开/折叠同一标记，靠明细行区分状态）
  segs.push({
    text: canExpand ? `${symbols.markerSquare} ` : '  ',
    color: theme.marker
  });

  const stats = resolveLineStats(tool);
  const showDelta =
    stats !== undefined &&
    (tool.name === 'Edit' || tool.name === 'Write') &&
    tool.status !== 'running' &&
    tool.status !== 'awaiting';

  const fullTitle = formatToolTitle(tool);
  let baseTitle = fullTitle;
  if (showDelta && stats) {
    const label = formatLineStatsLabel(stats);
    if (fullTitle.endsWith(` ${label}`)) {
      baseTitle = fullTitle.slice(0, -(label.length + 1));
    }
  }
  segs.push({ text: baseTitle, color: theme.brand, bold: true });

  if (showDelta && stats) {
    segs.push({ text: ' ' });
    if (stats.linesAdded === 0 && stats.linesRemoved === 0) {
      segs.push({ text: '±0', dim: true });
    } else {
      if (stats.linesAdded > 0) {
        segs.push({ text: `+${stats.linesAdded}`, color: theme.statusReady });
      }
      if (stats.linesAdded > 0 && stats.linesRemoved > 0) {
        segs.push({ text: ' ' });
      }
      if (stats.linesRemoved > 0) {
        segs.push({ text: `-${stats.linesRemoved}`, color: theme.statusError });
      }
    }
  }

  const status = toolStatusSegments(tool);
  if (status) {
    segs.push({ text: '  ' });
    segs.push(status);
  }

  const hint = toolStatusHint(tool);
  if (hint) {
    segs.push({ text: ` · ${hint}`, dim: true });
  }
  // 多文件聚合折叠时提示可展开（单次工具点标题即可，不刷屏）
  if (canExpand && !expanded && multiItem) {
    segs.push({ text: ' · ctrl+e', dim: true });
  }
  return segs;
}

function toolStatusSegments(tool: ToolCallState): PaintSegment | null {
  switch (tool.status) {
    case 'running':
      return { text: symbols.toolWait, color: theme.statusBusy };
    case 'completed':
      return { text: symbols.toolOk, color: theme.statusReady };
    case 'failed':
      return {
        text: `${symbols.toolFail} ${t('tool.status.failed')}`,
        color: theme.statusError
      };
    case 'denied':
      return {
        text: `${symbols.toolFail} ${t('tool.status.rejected')}`,
        color: theme.statusError
      };
    case 'cancelled':
      return {
        text: `${symbols.toolFail} ${t('tool.status.cancelled')}`,
        color: theme.statusWarn
      };
    case 'awaiting':
      return {
        text: `${symbols.toolWait} ${t('tool.status.waiting')}`,
        color: theme.statusWarn
      };
    default:
      return { text: tool.status, dim: true };
  }
}

function toolStatusHint(tool: ToolCallState): string | undefined {
  const summary = tool.summary?.replace(/\s+/g, ' ').trim();
  if (!summary) {
    return undefined;
  }
  if (
    tool.status === 'failed' ||
    tool.status === 'denied' ||
    tool.status === 'cancelled'
  ) {
    return summary.length > 48 ? `${summary.slice(0, 47)}…` : summary;
  }
  if (tool.status !== 'completed') {
    return undefined;
  }
  if (tool.name === 'Edit') {
    if (summary === 'no match' || summary.startsWith('ambiguous')) {
      return summary.length > 40 ? `${summary.slice(0, 39)}…` : summary;
    }
    const replaced = summary.match(/^replaced\s+(\d+)/i);
    if (replaced && Number(replaced[1]) > 1) {
      return `${replaced[1]}×`;
    }
  }
  if (tool.name === 'Bash') {
    const exit = summary.match(/exit=(-?\d+)/i);
    if (exit && exit[1] !== '0') {
      return `exit ${exit[1]}`;
    }
  }
  return undefined;
}

function paintAgent(
  message: ChatMessage,
  columns: number,
  streaming: boolean
): PaintItem[] {
  const items: PaintItem[] = [];
  // Claude Code: ● 与正文同一流，无标题行
  const mdLines = trimTrailingBlankMdLines(
    parseMarkdownStreaming(message.text, `msg-${message.id}`, streaming)
  );

  const bullet = `${symbols.agentBullet} `;
  const bulletWidth = displayWidth(bullet);
  const bodyWidth = Math.max(1, columns - bulletWidth);
  let firstContent = true;

  for (let i = 0; i < mdLines.length; i++) {
    const md = mdLines[i];
    if (!md) continue;
    if (md.kind === 'blank') {
      // 文中空行保留；尾部空行已在 trimTrailingBlankMdLines 去掉，
      // 避免与 agent-gap 叠成「消息和 tool 之间一大块留白」
      items.push({
        kind: 'line',
        key: `agent-${message.id}-L${i}-blank`,
        segments: [{ text: ' ' }],
        height: 1
      });
      continue;
    }
    const bodySegs = mdLineToSegments(md);
    const wrapped = wrapPaintSegments(bodySegs, bodyWidth);
    for (let w = 0; w < wrapped.length; w++) {
      const lineSegs = wrapped[w] ?? [{ text: ' ' }];
      const prefix: PaintSegment = firstContent
        ? { text: bullet, color: theme.agent }
        : { text: ' '.repeat(bulletWidth) };
      firstContent = false;
      items.push({
        kind: 'line',
        key: `agent-${message.id}-L${i}-W${w}`,
        segments: [prefix, ...lineSegs],
        height: 1
      });
    }
  }

  // 模型常输出结尾 \n\n；统一只保留一条消息间距
  items.push(blankItem(`agent-gap-${message.id}`));
  return items;
}

function paintThinking(
  message: ChatMessage,
  columns: number,
  streaming: boolean,
  nowMs: number
): PaintItem[] {
  const items: PaintItem[] = [];
  const expanded = message.expanded === true && !streaming;
  const label = formatThinkingLabel(message, streaming, undefined, nowMs);

  items.push(
    lineItem(
      `th-h-${message.id}`,
      [
        { text: `${symbols.markerSquare} `, color: theme.marker },
        { text: label, dim: true }
      ],
      columns
    )
  );

  if (expanded) {
    const bodyWidth = Math.max(1, columns - 2);
    const raw = trimTrailingEmptyLines(
      message.text.length === 0 ? [''] : message.text.split('\n')
    );
    for (let i = 0; i < raw.length; i++) {
      const wrapped = wrapPaintSegments(
        [{ text: raw[i] ?? '', dim: true }],
        bodyWidth
      );
      for (let w = 0; w < wrapped.length; w++) {
        items.push({
          kind: 'line',
          key: `th-${message.id}-L${i}-W${w}`,
          segments: [
            { text: '  ', dim: true },
            ...(wrapped[w] ?? [{ text: ' ' }])
          ],
          height: 1
        });
      }
    }
  }

  items.push(blankItem(`th-gap-${message.id}`));
  return items;
}

function mdLineToSegments(line: MdLine): PaintSegment[] {
  const segs: PaintSegment[] = [];
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
  if (segs.length === 0) {
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

/** Soft-wrap segments into height-1 lines (prefer this over Ink auto-wrap). */
function softWrapLineItems(
  keyPrefix: string,
  segments: PaintSegment[],
  columns: number
): PaintItem[] {
  const wrapped = wrapPaintSegments(segments, Math.max(1, columns));
  return wrapped.map((line, index) => ({
    kind: 'line' as const,
    key: `${keyPrefix}-W${index}`,
    segments: line.length > 0 ? line : [{ text: ' ' }],
    height: 1
  }));
}

/**
 * Wrap styled segments to `maxWidth` display columns without breaking styles.
 * Each output line is meant to render as a single terminal row (height=1).
 */
export function wrapPaintSegments(
  segments: PaintSegment[],
  maxWidth: number
): PaintSegment[][] {
  const width = Math.max(1, maxWidth);
  const lines: PaintSegment[][] = [];
  let current: PaintSegment[] = [];
  let used = 0;

  const flush = () => {
    lines.push(current.length > 0 ? current : [{ text: ' ' }]);
    current = [];
    used = 0;
  };

  for (const seg of segments) {
    let rest = seg.text;
    if (rest.length === 0) {
      continue;
    }
    while (rest.length > 0) {
      const room = width - used;
      if (room <= 0) {
        flush();
        continue;
      }
      const { taken, remaining } = takeByDisplayWidth(rest, room);
      if (taken.length === 0) {
        // No room for next full-width char: new line (unless empty line → force 1 cell)
        if (used === 0) {
          const forced = takeFirstCodePoint(rest);
          current.push({ ...seg, text: forced.taken });
          used += displayWidth(forced.taken);
          rest = forced.remaining;
          flush();
        } else {
          flush();
        }
        continue;
      }
      current.push({ ...seg, text: taken });
      used += displayWidth(taken);
      rest = remaining;
      if (rest.length > 0) {
        flush();
      }
    }
  }

  if (current.length > 0 || lines.length === 0) {
    flush();
  }
  return lines;
}

function takeByDisplayWidth(
  text: string,
  maxWidth: number
): { taken: string; remaining: string } {
  if (maxWidth <= 0 || text.length === 0) {
    return { taken: '', remaining: text };
  }
  let width = 0;
  let end = 0;
  let lastBreak = 0; // index after last whitespace (prefer soft wrap)
  for (const ch of text) {
    const w = displayWidth(ch);
    if (width + w > maxWidth) {
      break;
    }
    width += w;
    end += ch.length;
    if (ch === ' ' || ch === '\t') {
      lastBreak = end;
    }
  }
  // Prefer breaking at last whitespace when the line continues
  if (end < text.length && lastBreak > 0 && lastBreak < end) {
    end = lastBreak;
  }
  return {
    taken: text.slice(0, end),
    remaining: text.slice(end)
  };
}

function takeFirstCodePoint(text: string): { taken: string; remaining: string } {
  if (text.length === 0) {
    return { taken: '', remaining: '' };
  }
  const first = [...text][0] ?? '';
  return { taken: first, remaining: text.slice(first.length) };
}

function blankItem(key: string): PaintItem {
  return {
    kind: 'line',
    key,
    segments: [{ text: ' ' }],
    height: 1
  };
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') {
    end -= 1;
  }
  if (end === lines.length) {
    return lines;
  }
  return end === 0 ? [''] : lines.slice(0, end);
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
  return item.segments.map((s) => s.text).join('');
}
