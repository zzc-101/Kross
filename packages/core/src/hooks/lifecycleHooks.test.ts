import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TraceEvent } from '../domain';
import {
  ExperimentalLifecycleHooks,
  type ExperimentalLifecycleHookDiagnostic,
  type ExperimentalLifecycleHookEvent
} from './lifecycleHooks';

afterEach(() => {
  vi.useRealTimers();
});

describe('ExperimentalLifecycleHooks', () => {
  it('emits frozen, versioned metadata without trace input or output', async () => {
    const received: ExperimentalLifecycleHookEvent[] = [];
    const hooks = new ExperimentalLifecycleHooks({
      hooks: [
        async (event) => {
          received.push(event);
        }
      ]
    });

    hooks.notify(
      trace('tool_call.completed', {
        toolName: 'remote__search',
        risk: 'network',
        status: 'completed',
        input: { token: 'secret-input' },
        contentPreview: 'secret-output',
        summary: 'secret-summary'
      })
    );
    await hooks.flush();

    expect(received).toEqual([
      {
        version: 1,
        type: 'tool.completed',
        runId: 'run-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        tool: { name: 'remote__search', risk: 'network' },
        outcome: 'completed'
      }
    ]);
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(Object.isFrozen(received[0]?.tool)).toBe(true);
    expect(JSON.stringify(received)).not.toContain('secret');
    await hooks.close();
  });

  it('isolates failures, times out slow hooks, and drops excess pending events', async () => {
    vi.useFakeTimers();
    const diagnostics: ExperimentalLifecycleHookDiagnostic[] = [];
    const hooks = new ExperimentalLifecycleHooks({
      timeoutMs: 20,
      maxPendingEvents: 1,
      hooks: [
        async (_event, { signal }) =>
          new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        async () => {
          throw new Error('hook failed without secret payload');
        }
      ],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    hooks.notify(trace('run.started', {}));
    hooks.notify(trace('run.completed', { status: 'completed' }));
    await vi.advanceTimersByTimeAsync(21);
    await hooks.flush();

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'hook.dropped' }),
        expect.objectContaining({ code: 'hook.error', hookIndex: 1 }),
        expect.objectContaining({ code: 'hook.timeout', hookIndex: 0 })
      ])
    );
    await hooks.close();
  });

  it('rate limits accepted lifecycle events independently of trace payloads', async () => {
    const received: string[] = [];
    const diagnostics: ExperimentalLifecycleHookDiagnostic[] = [];
    const hooks = new ExperimentalLifecycleHooks({
      maxEventsPerSecond: 1,
      now: () => 100,
      hooks: [
        (event) => {
          received.push(event.type);
        }
      ],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    hooks.notify(trace('run.started', {}));
    hooks.notify(trace('run.completed', { status: 'completed' }));
    await hooks.flush();

    expect(received).toEqual(['run.started']);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'hook.dropped',
        eventType: 'run.completed'
      })
    ]);
    await hooks.close();
  });
});

function trace(
  type: string,
  payload: Record<string, unknown>
): TraceEvent {
  return {
    id: `event-${type}`,
    runId: 'run-1',
    type,
    timestamp: '2026-01-01T00:00:00.000Z',
    payload
  };
}
