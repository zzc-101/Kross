import type { TraceEvent } from '@kross/core';

export type SubagentUiStatus = 'running' | 'completed' | 'failed';

export interface SubagentUiState {
  subRunId: string;
  parentRunId: string;
  mode: string;
  status: SubagentUiStatus;
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

/** Hard filter: subagent tool traffic must not paint into main transcript. */
export function isSubagentTraceEvent(event: TraceEvent): boolean {
  if (event.payload?.isSubagent === true) {
    // Lifecycle events on the parent run still carry isSubagent=true but must
    // drive the panel (subagent.started/completed/failed).
    if (
      event.type === 'subagent.started' ||
      event.type === 'subagent.completed' ||
      event.type === 'subagent.failed'
    ) {
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
    const next: SubagentUiState = {
      subRunId,
      parentRunId:
        typeof payload.parentRunId === 'string'
          ? payload.parentRunId
          : event.runId,
      mode: typeof payload.mode === 'string' ? payload.mode : 'explore',
      status: 'running',
      promptPreview:
        typeof payload.promptPreview === 'string'
          ? payload.promptPreview
          : undefined,
      toolCount: 0,
      updatedAt: now
    };
    return [
      next,
      ...current.filter((item) => item.subRunId !== subRunId)
    ].slice(0, 4);
  }

  if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
    const subRunId =
      typeof payload.subRunId === 'string' ? payload.subRunId : undefined;
    if (!subRunId) {
      return current;
    }
    return current.map((item) => {
      if (item.subRunId !== subRunId) {
        return item;
      }
      return {
        ...item,
        status: event.type === 'subagent.completed' ? 'completed' : 'failed',
        summaryPreview:
          typeof payload.summaryPreview === 'string'
            ? payload.summaryPreview
            : item.summaryPreview,
        error:
          typeof payload.error === 'string' ? payload.error : item.error,
        currentTool: undefined,
        updatedAt: now
      };
    });
  }

  // Child tool activity → update the matching subagent row only.
  if (
    (isSubagentRunId(event.runId) || payload.isSubagent === true) &&
    (event.type === 'tool_call.started' ||
      event.type === 'tool_call.completed' ||
      event.type === 'tool_call.failed')
  ) {
    const toolName =
      typeof payload.toolName === 'string' ? payload.toolName : undefined;
    const targetId =
      typeof payload.subRunId === 'string' ? payload.subRunId : event.runId;
    return current.map((item) => {
      if (item.subRunId !== targetId && item.subRunId !== event.runId) {
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
 * Drop finished subagents older than maxAgeMs (keep running ones).
 * Default 60s so users can still expand and read the summary.
 */
export function pruneSubagentUi(
  current: SubagentUiState[],
  maxAgeMs = 60_000,
  now = Date.now()
): SubagentUiState[] {
  return current.filter(
    (item) =>
      item.status === 'running' || now - item.updatedAt < maxAgeMs
  );
}
