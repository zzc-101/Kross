import {
  cachedParseMarkdown,
  displayWidth,
  mdLineText
} from './markdownParse';
import type { ChatMessage } from './MessageLine';

/**
 * 消息行高估算（tool 卡片等仍用；全屏主路径以 MessagePaintCache 为准）。
 */
export function layoutFingerprint(message: ChatMessage): string {
  const tool = message.tool;
  const toolItems = tool?.items;
  const toolSig = tool
    ? [
        tool.name,
        tool.status,
        tool.summary ?? '',
        String(tool.linesAdded ?? ''),
        String(tool.linesRemoved ?? ''),
        String(tool.detailLines?.length ?? 0),
        tool.detailTruncated === true ? '1' : '0',
        toolItems
          ? `${toolItems.length}:${toolItems
              .map(
                (item) =>
                  `${item.status}:${item.path ?? ''}:${item.summary ?? ''}`
              )
              .join(',')}`
          : ''
      ].join('|')
    : '';
  const text = message.text;
  const head = text.slice(0, 24);
  const tail = text.length > 24 ? text.slice(-24) : '';
  return [
    message.from,
    message.expanded === true ? '1' : '0',
    String(text.length),
    head,
    tail,
    toolSig,
    message.durationMs !== undefined ? String(message.durationMs) : '-'
  ].join('\u0001');
}

/**
 * 估算消息在终端中占用的行数。
 */
export function estimateMessageRows(
  message: ChatMessage,
  columns: number
): number {
  const width = Math.max(20, columns);

  if (message.from === 'tool') {
    // 全屏 paint：标题 + 展开 detailLines + gap
    const gap = 1;
    if (message.expanded !== true) {
      return 1 + gap;
    }
    const detailCount = message.tool?.detailLines?.length ?? 0;
    if (detailCount > 0) {
      return 1 + detailCount + (message.tool?.detailTruncated ? 1 : 0) + gap;
    }
    const itemCount = message.tool?.items?.length ?? 1;
    return 1 + itemCount + gap;
  }

  if (message.from === 'system') {
    return countWrappedRows(message.text, width) + 1;
  }

  if (message.from === 'user') {
    return countWrappedRows(message.text.replace(/^\>\s*/, ''), width - 2) + 1;
  }

  if (message.from === 'thinking') {
    if (message.expanded !== true) {
      return 2; // Thought 摘要 + gap
    }
    const lines = message.text.length === 0 ? [''] : message.text.split('\n');
    let rows = 1;
    for (const line of lines) {
      rows += countWrappedRows(line, width - 2);
    }
    return rows + 1;
  }

  // agent：● 前缀
  return countVisualRows(message.text, width - 2) + 1;
}

/** 把 MD 渲染成终端可见的纯文本行（表格已展开为 box 字符） */
export function markdownToVisualLines(source: string): string[] {
  return cachedParseMarkdown(source).map((line) => mdLineText(line));
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
  const visualWidth = displayWidth(text);
  return Math.max(1, Math.ceil(visualWidth / width));
}
