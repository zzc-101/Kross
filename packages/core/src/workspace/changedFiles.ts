import type { TraceEvent } from '../domain';

/** 会改写工作区文件的内置工具。 */
const MUTATING_FILE_TOOLS = new Set(['Write', 'Edit']);

export interface TouchedFile {
  path: string;
  tools: string[];
}

/**
 * 从 run 的 tool_call 事件提取 agent 实际触达的文件。
 * 路径通常在 started.input 里，completed 只带 summary；按 callId 配对。
 * Edit 在未匹配 / 歧义时虽 completed，但不计入变更。
 */
export function extractTouchedFilesFromEvents(events: TraceEvent[]): TouchedFile[] {
  const startedPaths = new Map<string, { toolName: string; path: string }>();
  // 无 callId 时按工具名 FIFO 兜底
  const startedQueues = new Map<string, string[]>();
  const byPath = new Map<string, Set<string>>();

  for (const event of events) {
    if (event.type === 'tool_call.started') {
      const toolName = asString(event.payload.toolName);
      if (!toolName || !MUTATING_FILE_TOOLS.has(toolName)) {
        continue;
      }
      const path = extractPathFromInput(event.payload.input);
      if (!path) {
        continue;
      }
      const callId = asString(event.payload.callId);
      if (callId) {
        startedPaths.set(callId, { toolName, path });
      } else {
        const queue = startedQueues.get(toolName) ?? [];
        queue.push(path);
        startedQueues.set(toolName, queue);
      }
      continue;
    }

    if (event.type !== 'tool_call.completed') {
      continue;
    }

    const toolName = asString(event.payload.toolName);
    if (!toolName || !MUTATING_FILE_TOOLS.has(toolName)) {
      continue;
    }

    if (toolName === 'Edit' && !didEditMutate(event.payload)) {
      continue;
    }

    const callId = asString(event.payload.callId);
    let path =
      extractPathFromInput(event.payload.input) ??
      (callId ? startedPaths.get(callId)?.path : undefined);

    if (!path) {
      const queue = startedQueues.get(toolName);
      path = queue?.shift();
    }

    if (!path) {
      continue;
    }

    const tools = byPath.get(path) ?? new Set<string>();
    tools.add(toolName);
    byPath.set(path, tools);
  }

  return [...byPath.entries()]
    .map(([path, tools]) => ({
      path,
      tools: [...tools].sort()
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function extractChangedFilesFromEvents(events: TraceEvent[]): string[] {
  return extractTouchedFilesFromEvents(events).map((item) => item.path);
}

function didEditMutate(payload: Record<string, unknown>): boolean {
  const summary = asString(payload.summary) ?? '';
  if (summary === 'no match' || summary.startsWith('ambiguous:')) {
    return false;
  }
  // 正常替换：replaced N occurrence(s)
  if (summary.startsWith('replaced ')) {
    return true;
  }
  // 未知 summary 时保守计入（避免漏报）
  return summary.length === 0 || !summary.includes('未做修改');
}

function extractPathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const path = (input as { path?: unknown }).path;
  if (typeof path !== 'string') {
    return undefined;
  }
  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
