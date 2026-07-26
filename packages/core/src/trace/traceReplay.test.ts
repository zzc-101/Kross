import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '../domain';
import {
  formatTraceReplay,
  replayTraceEvents,
  TraceReplayError
} from './traceReplay';

describe('replayTraceEvents', () => {
  it('strictly derives a frame timeline without executing side effects', () => {
    const events = [
      event(0, 'run.started', { input: 'inspect repository' }),
      event(1, 'run.phase.changed', { phase: 'inspect' }),
      event(2, 'mode.detected', { mode: 'auto' }),
      event(3, 'tool_call.started', {
        toolName: 'Read',
        risk: 'read',
        callId: 'call-1'
      }),
      event(4, 'tool_call.completed', {
        toolName: 'Read',
        callId: 'call-1',
        status: 'completed',
        contentPreview: 'must not be rendered'
      }),
      event(5, 'run.phase.changed', { phase: 'complete' }),
      event(6, 'run.completed', {
        status: 'completed',
        mode: 'auto',
        summary: 'done'
      })
    ];

    const replay = replayTraceEvents('run-1', events);

    expect(replay).toMatchObject({
      version: 1,
      runId: 'run-1',
      eventCount: 7,
      status: 'completed',
      mode: 'auto',
      phase: 'complete'
    });
    expect(replay.frames[3]).toMatchObject({ activeToolCalls: 1 });
    expect(replay.frames[4]).toMatchObject({ activeToolCalls: 0 });
    const formatted = formatTraceReplay(replay);
    expect(formatted).toContain('仅派生状态');
    expect(formatted).not.toContain('must not be rendered');
  });

  it.each([
    {
      name: 'missing run start',
      events: [event(0, 'mode.detected', { mode: 'auto' })],
      code: 'missing-start'
    },
    {
      name: 'unknown event',
      events: [
        event(0, 'run.started', { input: 'x' }),
        event(1, 'future.event', {})
      ],
      code: 'unknown-event'
    },
    {
      name: 'out-of-order timestamp',
      events: [
        event(2, 'run.started', { input: 'x' }),
        event(1, 'mode.detected', { mode: 'auto' })
      ],
      code: 'out-of-order'
    },
    {
      name: 'tool terminal without start',
      events: [
        event(0, 'run.started', { input: 'x' }),
        event(1, 'tool_call.completed', {
          toolName: 'Read',
          callId: 'missing'
        })
      ],
      code: 'missing-tool-start'
    },
    {
      name: 'event after completion',
      events: [
        event(0, 'run.started', { input: 'x' }),
        event(1, 'run.completed', { status: 'completed' }),
        event(2, 'context.compacted', {})
      ],
      code: 'event-after-completion'
    }
  ])('fails explicitly for $name', ({ events, code }) => {
    expect(() => replayTraceEvents('run-1', events)).toThrow(
      expect.objectContaining({
        name: 'TraceReplayError',
        code
      }) as TraceReplayError
    );
  });

  it('rejects mixed runs and duplicate event ids', () => {
    const mixed = [
      event(0, 'run.started', { input: 'x' }),
      { ...event(1, 'mode.detected', { mode: 'auto' }), runId: 'run-2' }
    ];
    expect(() => replayTraceEvents('run-1', mixed)).toThrow(
      expect.objectContaining({ code: 'wrong-run' }) as TraceReplayError
    );

    const first = event(0, 'run.started', { input: 'x' });
    expect(() =>
      replayTraceEvents('run-1', [
        first,
        { ...event(1, 'mode.detected', { mode: 'auto' }), id: first.id }
      ])
    ).toThrow(
      expect.objectContaining({ code: 'duplicate-id' }) as TraceReplayError
    );
  });
});

function event(
  offsetSeconds: number,
  type: string,
  payload: Record<string, unknown>
): TraceEvent {
  return {
    id: `event-${offsetSeconds}-${type}`,
    runId: 'run-1',
    type,
    timestamp: new Date(
      Date.parse('2026-01-01T00:00:00.000Z') + offsetSeconds * 1_000
    ).toISOString(),
    payload
  };
}
