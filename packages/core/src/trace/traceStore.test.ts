import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('lists runs newest-first and inspects a single run', async () => {
    const store = new JsonlTraceStore(rootDir);

    await store.append(event('run-old', 'run.started', { input: 'old' }));
    await store.append({
      ...event('run-old', 'run.completed', { status: 'completed' }),
      id: 'run-old-done',
      timestamp: '2026-07-06T06:30:01.000Z'
    });
    await store.append({
      ...event('run-new', 'run.started', { input: 'new task' }),
      id: 'run-new-start',
      timestamp: '2026-07-06T07:00:00.000Z'
    });
    await store.append({
      ...event('run-new', 'tool_call.completed', {
        toolName: 'Read',
        summary: 'ok',
        durationMs: 3
      }),
      id: 'run-new-tool',
      timestamp: '2026-07-06T07:00:01.000Z'
    });
    await store.append({
      ...event('run-new', 'run.completed', {
        status: 'completed',
        mode: 'auto',
        summary: 'done'
      }),
      id: 'run-new-done',
      timestamp: '2026-07-06T07:00:02.000Z'
    });

    await expect(store.listRunIds()).resolves.toEqual(['run-new', 'run-old']);

    const listed = await store.listRuns({ limit: 1 });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.runId).toBe('run-new');
    expect(listed[0]?.tools).toContain('Read');

    const detail = await store.inspectRun('run-new');
    expect(detail?.status).toBe('completed');
    expect(detail?.toolLines.some((line) => line.toolName === 'Read')).toBe(true);

    await expect(store.listRunIds()).resolves.toHaveLength(2);
    await expect(store.inspectRun('missing')).resolves.toBeNull();
  });

  it('returns empty list when root directory does not exist', async () => {
    const store = new JsonlTraceStore(join(rootDir, 'does-not-exist'));
    await expect(store.listRunIds()).resolves.toEqual([]);
    await expect(store.listRuns()).resolves.toEqual([]);
  });

  it('skips corrupt lines and does not fail list when a run is broken', async () => {
    const store = new JsonlTraceStore(rootDir);
    await store.append(event('run-good', 'run.started', { input: 'ok' }));
    await store.append({
      ...event('run-good', 'run.completed', { status: 'completed', summary: 'done' }),
      id: 'run-good-done',
      timestamp: '2026-07-06T08:00:00.000Z'
    });

    const badDir = join(rootDir, 'run-bad');
    await mkdir(badDir, { recursive: true });
    await writeFile(
      join(badDir, 'events.jsonl'),
      '{not-json\n{"id":"x","runId":"run-bad","type":"run.started","timestamp":"nope","payload":{}}\n',
      'utf8'
    );

    const ids = await store.listRunIds();
    expect(ids).toEqual(expect.arrayContaining(['run-good', 'run-bad']));

    const listed = await store.listRuns({ limit: 10 });
    expect(listed.map((item) => item.runId)).toContain('run-good');
    // 全坏行 → 无有效事件 → 不进入摘要
    expect(listed.map((item) => item.runId)).not.toContain('run-bad');

    await expect(store.readRun('run-bad')).resolves.toEqual([]);
    await expect(store.readRun('../escape')).resolves.toEqual([]);
    await expect(store.inspectRun('..')).resolves.toBeNull();
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
