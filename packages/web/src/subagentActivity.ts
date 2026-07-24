import type { SessionSnapshot } from '@kross/protocol';

export type CloudTrace = SessionSnapshot['traces'][number];
export type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubagentActivity {
  subRunId: string;
  parentRunId: string;
  mode: string;
  status: SubagentStatus;
  title?: string;
  currentTool?: string;
  toolCount: number;
  summary?: string;
  updatedAt: number;
}

export function isSubagentToolTrace(trace: CloudTrace): boolean {
  if (trace.type.startsWith('subagent.')) return false;
  return (
    trace.runId.startsWith('sub-') ||
    trace.payload.isSubagent === true
  ) && trace.type.startsWith('tool_call.');
}

export function deriveSubagentActivities(
  traces: CloudTrace[],
  limit = 4
): SubagentActivity[] {
  const activities: SubagentActivity[] = [];
  for (const trace of traces) {
    const payload = trace.payload;
    const updatedAt = Date.parse(trace.timestamp) || 0;
    if (trace.type === 'subagent.started') {
      const subRunId =
        typeof payload.subRunId === 'string' ? payload.subRunId : undefined;
      if (!subRunId) continue;
      const parentRunId =
        typeof payload.parentRunId === 'string'
          ? payload.parentRunId
          : trace.runId;
      for (const activity of activities) {
        if (
          activity.parentRunId === parentRunId &&
          activity.status === 'running'
        ) {
          activity.status = 'cancelled';
        }
      }
      const prompt =
        typeof payload.promptPreview === 'string'
          ? payload.promptPreview
          : undefined;
      activities.unshift({
        subRunId,
        parentRunId,
        mode: typeof payload.mode === 'string' ? payload.mode : 'explore',
        status: 'running',
        title:
          typeof payload.title === 'string'
            ? payload.title
            : prompt?.replace(/\s+/g, ' ').trim().slice(0, 48),
        toolCount: 0,
        updatedAt
      });
      continue;
    }
    if (
      trace.type === 'subagent.completed' ||
      trace.type === 'subagent.failed' ||
      trace.type === 'subagent.cancelled'
    ) {
      const subRunId =
        typeof payload.subRunId === 'string' ? payload.subRunId : undefined;
      const activity = activities.find((item) => item.subRunId === subRunId);
      if (!activity) continue;
      activity.status =
        trace.type === 'subagent.completed'
          ? 'completed'
          : trace.type === 'subagent.failed'
            ? 'failed'
            : 'cancelled';
      activity.currentTool = undefined;
      activity.summary =
        typeof payload.summaryPreview === 'string'
          ? payload.summaryPreview
          : typeof payload.error === 'string'
            ? payload.error
            : typeof payload.reason === 'string'
              ? payload.reason
              : undefined;
      activity.updatedAt = updatedAt;
      continue;
    }
    if (isSubagentToolTrace(trace)) {
      const subRunId =
        typeof payload.subRunId === 'string' ? payload.subRunId : trace.runId;
      const activity = activities.find((item) => item.subRunId === subRunId);
      if (!activity || activity.status !== 'running') continue;
      if (trace.type === 'tool_call.started') {
        activity.currentTool =
          typeof payload.toolName === 'string'
            ? payload.toolName
            : activity.currentTool;
        activity.toolCount += 1;
      } else {
        activity.currentTool = undefined;
      }
      activity.updatedAt = updatedAt;
    }
  }
  return activities.slice(0, limit);
}
