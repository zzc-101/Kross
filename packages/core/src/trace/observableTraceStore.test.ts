import { describe, expect, it, vi } from 'vitest';

import type { TraceEvent } from '../domain';
import { ObservableTraceStore } from './observableTraceStore';
import type { TraceStore } from './traceStore';

describe('ObservableTraceStore', () => {
  it('forwards append/read to the inner store and notifies subscribers', async () => {
    const events: TraceEvent[] = [];
    const inner: TraceStore = {
      async append(event) {
        events.push(event);
      },
      async readRun(runId) {
        return events.filter((event) => event.runId === runId);
      }
    };
    const store = new ObservableTraceStore(inner);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const event: TraceEvent = {
      id: 'e1',
      runId: 'run-1',
      type: 'tool_call.started',
      timestamp: new Date().toISOString(),
      payload: { toolName: 'Read' }
    };

    await store.append(event);
    expect(events).toEqual([event]);
    expect(listener).toHaveBeenCalledWith(event);
    expect(await store.readRun('run-1')).toEqual([event]);

    unsubscribe();
    await store.append({ ...event, id: 'e2' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates listener errors so other subscribers still receive events', async () => {
    const inner: TraceStore = {
      async append() {},
      async readRun() {
        return [];
      }
    };
    const store = new ObservableTraceStore(inner);
    const bad = vi.fn(() => {
      throw new Error('ui boom');
    });
    const good = vi.fn();
    store.subscribe(bad);
    store.subscribe(good);

    const event: TraceEvent = {
      id: 'e1',
      runId: 'run-1',
      type: 'tool_call.completed',
      timestamp: new Date().toISOString(),
      payload: { toolName: 'Read' }
    };

    await expect(store.append(event)).resolves.toBeUndefined();
    expect(bad).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledWith(event);
  });
});
