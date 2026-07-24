export interface ToolActivityTrace {
  id: string;
  runId?: string;
  type: string;
  payload: Record<string, unknown>;
}

export function latestToolActivities<T extends ToolActivityTrace>(
  traces: T[],
  persistedCallIds: ReadonlySet<string>,
  limit = 6
): T[] {
  const latest = new Map<string, T>();
  for (const trace of traces) {
    if (!trace.type.startsWith('tool_call.')) continue;
    if (
      trace.runId?.startsWith('sub-') ||
      trace.payload.isSubagent === true
    ) {
      continue;
    }
    const callId =
      typeof trace.payload.callId === 'string'
        ? trace.payload.callId
        : undefined;
    if (callId && persistedCallIds.has(callId)) continue;
    const key = callId ?? trace.id;
    latest.delete(key);
    latest.set(key, trace);
  }
  return [...latest.values()].slice(-limit);
}
