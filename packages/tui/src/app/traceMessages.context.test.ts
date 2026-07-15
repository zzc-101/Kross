import { describe, expect, it, vi } from 'vitest';

import type { TraceEvent } from '@kross/core';

import { handleTraceEvent } from './traceMessages';

describe('handleTraceEvent context.compacted', () => {
  it('inserts a system notice when context is compacted', () => {
    const appendSystem = vi.fn();
    const event: TraceEvent = {
      id: 'e1',
      runId: 'run-1',
      type: 'context.compacted',
      timestamp: '2026-07-15T10:00:00.000Z',
      payload: {
        compacted: true,
        stage: 'turn-compaction',
        tokensBefore: 45_200,
        tokensAfter: 18_100
      }
    };

    handleTraceEvent(event, {
      upsertToolMessage: () => 1,
      setLoadingVariant: () => {},
      setAwaitingReply: () => {},
      setStreamingMessageId: () => {},
      appendSystem
    });

    expect(appendSystem).toHaveBeenCalledWith(
      '上下文已压缩: Stage2, 45.2K -> 18.1K tokens'
    );
  });

  it('ignores non-compaction maintenance events', () => {
    const appendSystem = vi.fn();
    const event: TraceEvent = {
      id: 'e2',
      runId: 'run-1',
      type: 'context.compacted',
      timestamp: '2026-07-15T10:00:00.000Z',
      payload: {
        compacted: false,
        tokensBefore: 1000,
        tokensAfter: 1000
      }
    };

    handleTraceEvent(event, {
      upsertToolMessage: () => 1,
      setLoadingVariant: () => {},
      setAwaitingReply: () => {},
      setStreamingMessageId: () => {},
      appendSystem
    });

    expect(appendSystem).not.toHaveBeenCalled();
  });
});
