import { describe, expect, it, vi } from 'vitest';

import type { TraceEvent } from '@kross/core';

import { handleTraceEvent } from './traceMessages';

describe('handleTraceEvent subagent isolation', () => {
  it('ignores tool_call events from subagent run ids', () => {
    const upsertToolMessage = vi.fn();
    const handlers = {
      upsertToolMessage,
      setLoadingVariant: vi.fn(),
      setAwaitingReply: vi.fn(),
      setStreamingMessageId: vi.fn()
    };

    const event: TraceEvent = {
      id: 'e1',
      runId: 'sub-parent-xyz',
      type: 'tool_call.started',
      timestamp: new Date().toISOString(),
      payload: { toolName: 'Read', callId: 'c1', isSubagent: true }
    };
    handleTraceEvent(event, handlers);
    expect(upsertToolMessage).not.toHaveBeenCalled();

    const taggedMainId: TraceEvent = {
      id: 'e1b',
      runId: 'run-main',
      type: 'tool_call.started',
      timestamp: new Date().toISOString(),
      payload: { toolName: 'Write', callId: 'c1b', isSubagent: true }
    };
    handleTraceEvent(taggedMainId, handlers);
    expect(upsertToolMessage).not.toHaveBeenCalled();

    const mainEvent: TraceEvent = {
      id: 'e2',
      runId: 'run-main',
      type: 'tool_call.started',
      timestamp: new Date().toISOString(),
      payload: { toolName: 'Task', callId: 'c2' }
    };
    handleTraceEvent(mainEvent, handlers);
    expect(upsertToolMessage).toHaveBeenCalledTimes(1);
    expect(upsertToolMessage.mock.calls[0]?.[1]?.name).toBe('Task');
  });
});
