import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TraceEvent } from '../domain';
import {
  createWorkspaceKeyForTrace,
  SessionTraceStore
} from './sessionTraceStore';

describe('SessionTraceStore', () => {
  let krossHome: string;

  beforeEach(async () => {
    krossHome = await mkdtemp(join(tmpdir(), 'kross-trace-store-'));
  });

  afterEach(async () => {
    await rm(krossHome, { recursive: true, force: true });
  });

  it('appends and reads trace events filtered by runId', async () => {
    const store = createStore('/tmp/project-a', 'ab12');
    const first = event('run-1', 'run.started', { goal: 'hello' });
    const second = event('run-1', 'run.completed', { status: 'completed' });
    const otherRun = {
      ...event('run-2', 'run.started', { goal: 'other' }),
      id: 'run-2-start',
      timestamp: '2026-07-06T06:31:00.000Z'
    };

    await store.append(first);
    await store.append(otherRun);
    await store.append(second);

    await expect(store.readRun('run-1')).resolves.toEqual([first, second]);
    await expect(store.readRun('run-2')).resolves.toEqual([otherRun]);
    store.close();
  });

  it('lists runIds newest-first and isolates workspaces', async () => {
    const workspaceA = join(krossHome, 'workspace-a');
    const workspaceB = join(krossHome, 'workspace-b');
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceB, { recursive: true });

    const storeA = createStore(workspaceA, 'aaaa');
    const storeB = createStore(workspaceB, 'bbbb');

    await storeA.append({
      ...event('run-old', 'run.started', { input: 'old' }),
      timestamp: '2026-07-06T06:30:00.000Z'
    });
    await storeA.append({
      ...event('run-old', 'run.completed', { status: 'completed' }),
      id: 'run-old-done',
      timestamp: '2026-07-06T06:30:01.000Z'
    });
    await storeA.append({
      ...event('run-new', 'run.started', { input: 'new' }),
      id: 'run-new-start',
      timestamp: '2026-07-06T07:00:00.000Z'
    });
    await storeB.append(event('run-b', 'run.started', { input: 'b' }));

    await expect(storeA.listRunIds()).resolves.toEqual(['run-new', 'run-old']);
    await expect(storeB.listRunIds()).resolves.toEqual(['run-b']);
    await expect(storeA.readRun('run-b')).resolves.toEqual([]);
    await expect(storeB.readRun('run-new')).resolves.toEqual([]);

    storeA.close();
    storeB.close();
  });

  it('keeps identical runIds isolated by workspace', async () => {
    const workspaceA = join(krossHome, 'same-run-a');
    const workspaceB = join(krossHome, 'same-run-b');
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceB, { recursive: true });

    const storeA = createStore(workspaceA, 'a001');
    const storeB = createStore(workspaceB, 'b001');
    const eventA = event('run-shared', 'run.started', { workspace: 'a' });
    const eventB = {
      ...event('run-shared', 'run.started', { workspace: 'b' }),
      id: 'run-shared-b'
    };

    await storeA.append(eventA);
    await storeB.append(eventB);

    await expect(storeA.readRun('run-shared')).resolves.toEqual([eventA]);
    await expect(storeB.readRun('run-shared')).resolves.toEqual([eventB]);
    await expect(storeA.listRunIds()).resolves.toEqual(['run-shared']);
    await expect(storeB.listRunIds()).resolves.toEqual(['run-shared']);

    storeA.close();
    storeB.close();
  });

  it('migrates the v1 index without losing existing run data', async () => {
    const workspacePath = join(krossHome, 'legacy-workspace');
    await mkdir(workspacePath, { recursive: true });
    const workspaceKey = createWorkspaceKeyForTrace(workspacePath);
    const workspaceDir = join(krossHome, 'traces', workspaceKey);
    await mkdir(workspaceDir, { recursive: true });
    const legacyFile = join(workspaceDir, '2026-07-15T08-00-00-old1.jsonl');
    const legacyEvent = event('legacy-run', 'run.started', { source: 'v1' });
    await writeFile(legacyFile, `${JSON.stringify(legacyEvent)}\n`, 'utf8');

    const dbPath = join(krossHome, 'traces', 'index.db');
    const seedDb = new Database(dbPath);
    seedDb.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at)
        VALUES (1, '2026-07-15T08:00:00.000Z');
      CREATE TABLE trace_runs (
        run_id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        file_path TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    seedDb
      .prepare(
        `INSERT INTO trace_runs (
           run_id, workspace_key, file_path, first_seen, last_seen, event_count
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        'legacy-run',
        workspaceKey,
        legacyFile,
        legacyEvent.timestamp,
        legacyEvent.timestamp,
        1
      );
    seedDb.close();

    const store = new SessionTraceStore({
      krossHome,
      workspacePath,
      now: () => new Date('2026-07-15T09:00:00.000Z'),
      randomSuffix: () => 'new2'
    });

    await expect(store.readRun('legacy-run')).resolves.toEqual([legacyEvent]);
    const db = new Database(store.databasePath);
    const primaryKeyColumns = db
      .prepare('PRAGMA table_info(trace_runs)')
      .all()
      .filter((column) => (column as { pk: number }).pk > 0)
      .sort(
        (left, right) =>
          (left as { pk: number }).pk - (right as { pk: number }).pk
      )
      .map((column) => (column as { name: string }).name);
    db.close();
    expect(primaryKeyColumns).toEqual(['workspace_key', 'run_id']);

    store.close();
  });

  it('falls back to the current session file when index row is missing', async () => {
    const store = createStore('/tmp/project-fallback', 'ff01');
    const first = event('run-fallback', 'run.started', { input: 'ok' });
    const second = {
      ...event('run-fallback', 'run.completed', { status: 'completed' }),
      id: 'run-fallback-done',
      timestamp: '2026-07-06T08:00:00.000Z'
    };

    await store.append(first);
    await store.append(second);

    const db = new Database(store.databasePath);
    db.prepare('DELETE FROM trace_runs WHERE run_id = ?').run('run-fallback');
    db.close();

    await expect(store.readRun('run-fallback')).resolves.toEqual([first, second]);
    store.close();
  });

  it('prunes trace files older than 30 days and removes index rows', async () => {
    const workspacePath = join(krossHome, 'retention-workspace');
    await mkdir(workspacePath, { recursive: true });
    const workspaceKey = createWorkspaceKeyForTrace(workspacePath);
    const workspaceDir = join(krossHome, 'traces', workspaceKey);
    await mkdir(workspaceDir, { recursive: true });

    const staleFile = join(workspaceDir, '2020-01-01T00-00-00-dead.jsonl');
    await writeFile(
      staleFile,
      `${JSON.stringify(event('stale-run', 'run.started'))}\n`,
      'utf8'
    );
    const staleDate = new Date('2020-01-01T00:00:00.000Z');
    await utimes(staleFile, staleDate, staleDate);

    const dbPath = join(krossHome, 'traces', 'index.db');
    const seedDb = new Database(dbPath);
    seedDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trace_runs (
        run_id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        file_path TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    seedDb
      .prepare(
        `INSERT INTO trace_runs (
           run_id, workspace_key, file_path, first_seen, last_seen, event_count
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        'stale-run',
        workspaceKey,
        staleFile,
        '2020-01-01T00:00:00.000Z',
        '2020-01-01T00:00:00.000Z',
        1
      );
    seedDb.close();

    const store = new SessionTraceStore({
      krossHome,
      workspacePath,
      now: () => new Date('2026-07-15T09:00:00.000Z'),
      randomSuffix: () => 'live'
    });

    expect(store.sessionFilePath.endsWith('2026-07-15T09-00-00-live.jsonl')).toBe(
      true
    );

    const db = new Database(store.databasePath);
    const staleRow = db
      .prepare('SELECT run_id FROM trace_runs WHERE run_id = ?')
      .get('stale-run');
    db.close();

    await expect(store.readRun('stale-run')).resolves.toEqual([]);
    expect(staleRow).toBeUndefined();

    store.close();
  });

  it('closes the sqlite handle', async () => {
    const store = createStore('/tmp/project-close', 'c10e');
    await store.append(event('run-close', 'run.started'));
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  it('rejects invalid events before writing them', async () => {
    const store = createStore('/tmp/project-invalid', 'bad1');

    await expect(
      store.append({
        id: 'bad',
        type: 'run.started',
        timestamp: '2026-07-06T06:30:00.000Z',
        payload: {}
      } as TraceEvent)
    ).rejects.toThrow();

    await expect(store.readRun('missing-run')).resolves.toEqual([]);
    store.close();
  });

  function createStore(workspacePath: string, suffix: string): SessionTraceStore {
    return new SessionTraceStore({
      krossHome,
      workspacePath,
      now: () => new Date('2026-07-06T06:30:00.000Z'),
      randomSuffix: () => suffix
    });
  }
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
