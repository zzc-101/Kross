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
    // raw string preview
  }
  const trimmed = inputPreview.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toToolItem(tool: ToolCallState): ToolCallItem {
  return {
    callId: tool.callId,
    path: extractToolPath(tool.inputPreview),
    preview: tool.inputPreview,
    status: tool.status,
    summary: tool.summary,
    durationMs: tool.durationMs
  };
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
  if (path) {
    const short = path.length > 48 ? `${path.slice(0, 47)}…` : path;
    return `${name} ${short}`;
  }
  return name;
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
    durationMs: next.durationMs ?? prev?.durationMs
  };
  return copy;
}

export function buildToolState(
  name: string,
  risk: string | undefined,
  items: ToolCallItem[]
): ToolCallState {
  const status = aggregateToolStatus(items);
  return {
    name,
    risk,
    status,
    items,
    callId: items.length === 1 ? items[0]?.callId : undefined,
    inputPreview: items.length === 1 ? items[0]?.preview : undefined,
    summary: items.length === 1 ? items[0]?.summary : undefined,
    durationMs:
      items.length === 1
        ? items[0]?.durationMs
        : items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
  };
}
