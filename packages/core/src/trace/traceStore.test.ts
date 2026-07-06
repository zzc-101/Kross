import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlTraceStore } from './traceStore';
import type { TraceEvent } from '../domain';

describe('JsonlTraceStore', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'local-agent-trace-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('appends and reads trace events in order', async () => {
    const store = new JsonlTraceStore(rootDir);
    const first = event('run-1', 'run.started', { goal: 'hello' });
    const second = event('run-1', 'run.completed', { status: 'completed' });

    await store.append(first);
    await store.append(second);

    await expect(store.readRun('run-1')).resolves.toEqual([first, second]);
  });

  it('creates run directories automatically', async () => {
    const store = new JsonlTraceStore(rootDir);

    await store.append(event('nested-run', 'planner.started'));

    await expect(store.readRun('nested-run')).resolves.toHaveLength(1);
  });

  it('rejects invalid events before writing them', async () => {
    const store = new JsonlTraceStore(rootDir);

    await expect(
      store.append({
        id: 'bad',
        type: 'run.started',
        timestamp: '2026-07-06T06:30:00.000Z',
        payload: {}
      } as TraceEvent)
    ).rejects.toThrow();

    await expect(store.readRun('missing-run')).resolves.toEqual([]);
  });
});

function event(
  runId: string,
  type: string,
  payload: Record<string, unknown> = {}
): TraceEvent {
  return {
    id: `${type}-${Object.keys(payload).length}`,
    runId,
    type,
    timestamp: '2026-07-06T06:30:00.000Z',
    payload
  };
}
