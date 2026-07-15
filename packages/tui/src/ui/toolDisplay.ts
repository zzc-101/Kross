import type { ToolCallItem, ToolCallState, ToolCallStatus } from './MessageLine';

const AGGREGATABLE = new Set([
  'Read',
  'Glob',
  'Grep',
  'fs.read',
  'fs.glob',
  'fs.grep'
]);

export function isAggregatableTool(name: string): boolean {
  return AGGREGATABLE.has(name) || name.toLowerCase() === 'read';
}

export function extractToolPath(inputPreview: string | undefined): string | undefined {
  if (!inputPreview) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(inputPreview) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.path === 'string') {
        return record.path;
      }
      if (typeof record.file_path === 'string') {
        return record.file_path;
      }
      if (typeof record.glob === 'string') {
        return record.glob;
      }
      if (typeof record.pattern === 'string') {
        const path = typeof record.path === 'string' ? record.path : '';
        return path ? `${record.pattern} in ${path}` : record.pattern;
      }
      if (typeof record.command === 'string') {
        return `$ ${record.command}`;
      }
    }
  } catch {
    // human-readable preview（Edit/Write/Bash）
  }

  // Bash: "$ command"
  if (inputPreview.startsWith('$ ')) {
    const flat = inputPreview.replace(/\s+/g, ' ').trim();
    return flat.length > 0 ? flat : undefined;
  }

  // 多行预览：首行常为 path；Write 也可能是 "path · N lines · …"
  const firstLine = inputPreview.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) {
    return undefined;
  }
  const beforeDot = firstLine.split(' · ')[0]?.trim() ?? firstLine;
  // path · replace_all 也会落在 first segment
  const withoutFlag = beforeDot.replace(/\s·\s*replace_all$/i, '').trim();
  return withoutFlag.length > 0 ? withoutFlag : firstLine;
}

export function toToolItem(tool: ToolCallState): ToolCallItem {
  const stats = resolveLineStats(tool);
  return {
    callId: tool.callId,
    path: extractToolPath(tool.inputPreview),
    preview: tool.inputPreview,
    status: tool.status,
    summary: tool.summary,
    durationMs: tool.durationMs,
    linesAdded: stats?.linesAdded,
    linesRemoved: stats?.linesRemoved
  };
}

export function resolveLineStats(tool: {
  linesAdded?: number;
  linesRemoved?: number;
  summary?: string;
}): { linesAdded: number; linesRemoved: number } | undefined {
  if (
    typeof tool.linesAdded === 'number' ||
    typeof tool.linesRemoved === 'number'
  ) {
    return {
      linesAdded: tool.linesAdded ?? 0,
      linesRemoved: tool.linesRemoved ?? 0
    };
  }
  return parseLineStatsFromSummary(tool.summary);
}

/** 从 summary 解析 `+3 -1` / `created +12` / `replaced 1 · +2 -1` */
export function parseLineStatsFromSummary(
  summary: string | undefined
): { linesAdded: number; linesRemoved: number } | undefined {
  if (!summary) {
    return undefined;
  }
  const addedMatch = summary.match(/(?<![.\d])\+(\d+)\b/);
  const removedMatch = summary.match(/(?<![.\d])-(\d+)\b/);
  if (!addedMatch && !removedMatch) {
    return undefined;
  }
  return {
    linesAdded: addedMatch ? Number(addedMatch[1]) : 0,
    linesRemoved: removedMatch ? Number(removedMatch[1]) : 0
  };
}

export function formatLineStatsLabel(stats: {
  linesAdded: number;
  linesRemoved: number;
}): string {
  const { linesAdded, linesRemoved } = stats;
  if (linesAdded === 0 && linesRemoved === 0) {
    return '±0';
  }
  const parts: string[] = [];
  if (linesAdded > 0) {
    parts.push(`+${linesAdded}`);
  }
  if (linesRemoved > 0) {
    parts.push(`-${linesRemoved}`);
  }
  return parts.join(' ');
}

export function ensureToolItems(tool: ToolCallState): ToolCallItem[] {
  if (tool.items && tool.items.length > 0) {
    return tool.items;
  }
  return [toToolItem(tool)];
}

export function aggregateToolStatus(items: ToolCallItem[]): ToolCallStatus {
  if (items.some((item) => item.status === 'running')) {
    return 'running';
  }
  if (items.some((item) => item.status === 'awaiting')) {
    return 'awaiting';
  }
  if (items.some((item) => item.status === 'failed')) {
    return 'failed';
  }
  if (items.some((item) => item.status === 'denied')) {
    return 'denied';
  }
  if (items.some((item) => item.status === 'cancelled')) {
    return 'cancelled';
  }
  return 'completed';
}

/** 标题：Read 5 files / Bash / Write path */
export function formatToolTitle(tool: ToolCallState): string {
  const items = ensureToolItems(tool);
  const name = tool.name;

  if (isAggregatableTool(name) || items.length > 1) {
    const count = items.length;
    if (isReadLike(name)) {
      return count === 1
        ? `Read ${items[0]?.path ?? '1 file'}`
        : `Read ${count} files`;
    }
    if (name === 'Glob' || name.toLowerCase() === 'glob') {
      return count === 1 ? `Glob ${items[0]?.path ?? ''}`.trim() : `Glob ${count} patterns`;
    }
    if (name === 'Grep' || name.toLowerCase() === 'grep') {
      return count === 1 ? `Grep ${items[0]?.path ?? ''}`.trim() : `Grep ${count} searches`;
    }
    return count === 1 ? name : `${name} ×${count}`;
  }

  // 单次非聚合工具：名称 + 简短预览
  const path = items[0]?.path;
  const stats = resolveLineStats(items[0] ?? tool);
  const delta =
    stats && (name === 'Edit' || name === 'Write')
      ? ` ${formatLineStatsLabel(stats)}`
      : '';
  if (path) {
    const short = path.length > 48 ? `${path.slice(0, 47)}…` : path;
    return `${name} ${short}${delta}`;
  }
  return `${name}${delta}`;
}

function isReadLike(name: string): boolean {
  return name === 'Read' || name === 'fs.read' || name.toLowerCase() === 'read';
}

export function mergeToolItem(
  items: ToolCallItem[],
  next: ToolCallItem
): ToolCallItem[] {
  const index = items.findIndex(
    (item) =>
      (next.callId && item.callId === next.callId) ||
      (!next.callId && next.path && item.path === next.path && item.status === 'running')
  );
  if (index < 0) {
    return [...items, next];
  }
  const copy = items.slice();
  const prev = copy[index];
  copy[index] = {
    callId: next.callId ?? prev?.callId,
    path: next.path ?? prev?.path,
    preview: next.preview ?? prev?.preview,
    status: next.status,
    summary: next.summary ?? prev?.summary,
    durationMs: next.durationMs ?? prev?.durationMs,
    linesAdded: next.linesAdded ?? prev?.linesAdded,
    linesRemoved: next.linesRemoved ?? prev?.linesRemoved
  };
  return copy;
}

export function buildToolState(
  name: string,
  risk: string | undefined,
  items: ToolCallItem[],
  extras?: Partial<
    Pick<
      ToolCallState,
      'detailLines' | 'detailTruncated' | 'linesAdded' | 'linesRemoved' | 'summary'
    >
  >
): ToolCallState {
  const status = aggregateToolStatus(items);
  const single = items.length === 1 ? items[0] : undefined;
  return {
    name,
    risk,
    status,
    items,
    callId: single?.callId,
    inputPreview: single?.preview,
    summary: extras?.summary ?? single?.summary,
    durationMs:
      items.length === 1
        ? single?.durationMs
        : items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
    linesAdded: extras?.linesAdded ?? single?.linesAdded,
    linesRemoved: extras?.linesRemoved ?? single?.linesRemoved,
    detailLines: extras?.detailLines,
    detailTruncated: extras?.detailTruncated
  };
}
