import type { TraceEvent } from '@kross/core';

export type SubagentUiStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SubagentUiState {
  subRunId: string;
  parentRunId: string;
  mode: string;
  status: SubagentUiStatus;
  /** 单行展示用短标题（优先 Task description） */
  title?: string;
  promptPreview?: string;
  currentTool?: string;
  toolCount: number;
  summaryPreview?: string;
  error?: string;
  updatedAt: number;
}

/** Child run ids are created as `sub-${parentRunId}-...`. */
export function isSubagentRunId(runId: string): boolean {
  return runId.startsWith('sub-');
}

const SUBAGENT_LIFECYCLE_TYPES = new Set([
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.cancelled'
]);

/** Hard filter: subagent tool traffic must not paint into main transcript. */
export function isSubagentTraceEvent(event: TraceEvent): boolean {
  if (event.payload?.isSubagent === true) {
    // Lifecycle events on the parent run still carry isSubagent=true but must
    // drive the panel (started/completed/failed/cancelled).
    if (SUBAGENT_LIFECYCLE_TYPES.has(event.type)) {
      return false;
    }
    return true;
  }
  if (
    isSubagentRunId(event.runId) &&
    (event.type.startsWith('tool_call.') ||
      event.type.startsWith('llm.subagent'))
  ) {
    return true;
  }
  return false;
}

/**
 * Reduce trace events into a list of subagent cards for the footer panel.
 */
export function applySubagentTraceEvent(
  current: SubagentUiState[],
  event: TraceEvent
): SubagentUiState[] {
  const now = Date.now();
  const payload = event.payload;

  if (event.type === 'subagent.started') {
    const subRunId =
      typeof payload.subRunId === 'string' ? payload.subRunId : undefined;
    if (!subRunId) {
      return current;
    }
    const parentRunId =
      typeof payload.parentRunId === 'string'
        ? payload.parentRunId
        : event.runId;
    const promptPreview =
      typeof payload.promptPreview === 'string'
        ? payload.promptPreview
        : undefined;
    const title =
      typeof payload.title === 'string' && payload.title.trim().length > 0
        ? payload.title.trim()
        : promptPreview
          ? promptPreview.replace(/\s+/g, ' ').trim().slice(0, 36)
          : undefined;
    const next: SubagentUiState = {
      subRunId,
      parentRunId,
      mode: typeof payload.mode === 'string' ? payload.mode : 'explore',
      status: 'running',
      title,
      promptPreview,
      toolCount: 0,
      updatedAt: now
    };
    // 同一 parent 下旧的仍 running 条目视为过期（终态丢失时防止僵尸 running）
    const rest = current
      .filter((item) => item.subRunId !== subRunId)
      .map((item) =>
        item.parentRunId === parentRunId && item.status === 'running'
          ? {
              ...item,
              status: 'cancelled' as const,
              currentTool: undefined,
              summaryPreview: item.summaryPreview ?? 'superseded',
              updatedAt: now
            }
          : item
      );
    return [next, ...rest].slice(0, 4);
  }

  if (
    event.type === 'subagent.completed' ||
    event.type === 'subagent.failed' ||
    event.type === 'subagent.cancelled'
  ) {
    const subRunId =
      typeof payload.subRunId === 'string' ? payload.subRunId : undefined;
    if (!subRunId) {
      return current;
    }
    const status: SubagentUiStatus =
      event.type === 'subagent.completed'
        ? 'completed'
        : event.type === 'subagent.cancelled'
          ? 'cancelled'
          : 'failed';
    const reason =
      typeof payload.reason === 'string'
        ? payload.reason
        : typeof payload.error === 'string'
          ? payload.error
          : undefined;
    return current.map((item) => {
      if (item.subRunId !== subRunId) {
        return item;
      }
      return {
        ...item,
        status,
        summaryPreview:
          typeof payload.summaryPreview === 'string'
            ? payload.summaryPreview
            : status === 'cancelled'
              ? item.summaryPreview ?? reason ?? 'interrupted'
              : item.summaryPreview,
        error: status === 'failed' ? reason ?? item.error : item.error,
        currentTool: undefined,
        updatedAt: now
      };
    });
  }

  // 主 run 结束（含 completed / cancelled / interrupted）：清掉该 parent 下仍 running 的条子
  // 否则 completed 过期 prune 后，僵尸 running 会重新顶到面板（用户看到的「过一会儿又 running」）
  if (event.type === 'run.interrupted' || event.type === 'run.completed') {
    const parentStatus =
      typeof payload.status === 'string' ? payload.status : undefined;
    const asCancelled =
      event.type === 'run.interrupted' || parentStatus === 'cancelled';
    let changed = false;
    const next = current.map((item) => {
      if (item.parentRunId !== event.runId || item.status !== 'running') {
        return item;
      }
      changed = true;
      return {
        ...item,
        status: (asCancelled ? 'cancelled' : 'completed') as SubagentUiStatus,
        currentTool: undefined,
        summaryPreview:
          item.summaryPreview ??
          (asCancelled ? 'interrupted' : 'done'),
        updatedAt: now
      };
    });
    return changed ? next : current;
  }

  // Child tool activity → update the matching subagent row only.
  if (
    (isSubagentRunId(event.runId) || payload.isSubagent === true) &&
    (event.type === 'tool_call.started' ||
      event.type === 'tool_call.completed' ||
      event.type === 'tool_call.failed' ||
      event.type === 'tool_call.cancelled')
  ) {
    const toolName =
      typeof payload.toolName === 'string' ? payload.toolName : undefined;
    const targetId =
      typeof payload.subRunId === 'string' ? payload.subRunId : event.runId;
    return current.map((item) => {
      if (item.subRunId !== targetId && item.subRunId !== event.runId) {
        return item;
      }
      // 已终态不再被迟到的 tool 事件打回 running
      if (item.status !== 'running') {
        return item;
      }
      if (event.type === 'tool_call.started') {
        return {
          ...item,
          status: 'running' as const,
          currentTool: toolName ?? item.currentTool,
          toolCount: item.toolCount + 1,
          updatedAt: now
        };
      }
      return {
        ...item,
        currentTool: undefined,
        updatedAt: now
      };
    });
  }

  return current;
}

/**
 * 清理面板条目：
 * - running：仅在「最近有活动」时保留；超过 runningMaxAgeMs 无更新则丢弃（防僵尸）
 * - cancelled：较快淡出
 * - completed/failed：保留 maxAgeMs
 */
export function pruneSubagentUi(
  current: SubagentUiState[],
  maxAgeMs = 60_000,
  now = Date.now(),
  cancelledMaxAgeMs = 15_000,
  /** 无 tool/生命周期更新的 running 最长存活；超时当僵尸丢掉 */
  runningMaxAgeMs = 3 * 60_000
): SubagentUiState[] {
  const next = current.filter((item) => {
    const age = now - item.updatedAt;
    if (item.status === 'running') {
      return age < runningMaxAgeMs;
    }
    if (item.status === 'cancelled') {
      return age < cancelledMaxAgeMs;
    }
    return age < maxAgeMs;
  });
  return next.length === current.length ? current : next;
}
