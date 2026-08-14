import type { TraceEvent } from '../domain';

/** 会改写工作区文件的内置工具。 */
const MUTATING_FILE_TOOLS = new Set([
  'Write',
  'Edit',
  'Delete',
  'Move',
  'ApplyPatch'
]);

export interface TouchedFile {
  path: string;
  tools: string[];
}

/**
 * 从 run 的 tool_call 事件提取 agent 实际触达的文件。
 * 路径通常在 started.input 里，completed 只带 summary；按 callId 配对。
 * Edit/Delete/Move 在未真正变更时虽 completed，但不计入。
 */
export function extractTouchedFilesFromEvents(events: TraceEvent[]): TouchedFile[] {
  const startedPaths = new Map<string, { toolName: string; paths: string[] }>();
  const startedQueues = new Map<string, string[][]>();
  const byPath = new Map<string, Set<string>>();

  for (const event of events) {
    if (event.type === 'tool_call.started') {
      const toolName = asString(event.payload.toolName);
      if (!toolName || !MUTATING_FILE_TOOLS.has(toolName)) {
        continue;
      }
      const paths = extractPathsFromInput(event.payload.input);
      if (paths.length === 0) {
        continue;
      }
      const callId = asString(event.payload.callId);
      if (callId) {
        startedPaths.set(callId, { toolName, paths });
      } else {
        const queue = startedQueues.get(toolName) ?? [];
        queue.push(paths);
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

    if (!didMutate(toolName, event.payload)) {
      continue;
    }

    const callId = asString(event.payload.callId);
    // completed 事件通常无 input，优先 callId 配对 started
    let paths = extractPathsFromInput(event.payload.input);
    if (paths.length === 0 && callId) {
      paths = startedPaths.get(callId)?.paths ?? [];
    }
    if (paths.length === 0) {
      paths = startedQueues.get(toolName)?.shift() ?? [];
    }
    // completed.data 可能含 path / from / to
    if (paths.length === 0 && event.payload.data) {
      paths = extractPathsFromInput(event.payload.data);
    }

    if (paths.length === 0) {
      continue;
    }

    for (const path of paths) {
      const tools = byPath.get(path) ?? new Set<string>();
      tools.add(toolName);
      byPath.set(path, tools);
    }
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

/** 返回最后一次已完成文件修改在 trace 中的位置；没有修改时返回 -1。 */
export function findLastFileMutationIndex(events: TraceEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (isCompletedFileMutationEvent(events[index]!)) {
      return index;
    }
  }
  return -1;
}

/** 仅把确认完成且实际产生变更的文件工具事件视为 mutation。 */
export function isCompletedFileMutationEvent(event: TraceEvent): boolean {
  if (event.type !== 'tool_call.completed') {
    return false;
  }
  const toolName = asString(event.payload.toolName);
  return Boolean(
    toolName &&
      MUTATING_FILE_TOOLS.has(toolName) &&
      didMutate(toolName, event.payload)
  );
}

function didMutate(toolName: string, payload: Record<string, unknown>): boolean {
  const data = payload.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const mutated = (data as { mutated?: unknown }).mutated;
    if (typeof mutated === 'boolean') {
      return mutated;
    }
  }

  const summary = asString(payload.summary) ?? '';

  if (toolName === 'Edit') {
    if (
      summary === 'no match' ||
      summary === 'no change' ||
      summary.startsWith('ambiguous:')
    ) {
      return false;
    }
    if (summary.startsWith('replaced ')) {
      return true;
    }
    return summary.length === 0 || !summary.includes('未做修改');
  }

  if (toolName === 'Delete') {
    if (summary.startsWith('refused') || summary.includes('no-op')) {
      return false;
    }
    return summary.startsWith('deleted') || summary.length === 0;
  }

  if (toolName === 'Move') {
    if (summary.includes('no-op')) {
      return false;
    }
    return summary.startsWith('moved') || summary.length === 0;
  }

  return true;
}

function extractPathsFromInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') {
    return [];
  }
  const record = input as Record<string, unknown>;
  const paths: string[] = [];

  if (typeof record.path === 'string' && record.path.trim().length > 0) {
    paths.push(record.path.trim());
  }
  if (typeof record.from === 'string' && record.from.trim().length > 0) {
    paths.push(record.from.trim());
  }
  if (typeof record.to === 'string' && record.to.trim().length > 0) {
    paths.push(record.to.trim());
  }
  if (Array.isArray(record.files)) {
    for (const path of record.files) {
      if (typeof path === 'string' && path.trim().length > 0) {
        paths.push(path.trim());
      }
    }
  }

  return [...new Set(paths)];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
