import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HybridSessionStore } from './sessionStore';
import { SessionContext } from '../context/sessionContext';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('HybridSessionStore', () => {
  it('writes canonical JSONL events and lists the SQLite projection', () => {
    const { root, workspace, store } = createStore();
    const created = store.createSession(workspace);

    store.upsertMessage(created.id, {
      id: 1,
      from: 'user',
      text: '> 把登录流程做成产品级实现',
      createdAt: '2026-07-14T10:00:01.000Z'
    });
    store.upsertMessage(created.id, {
      id: 2,
      from: 'agent',
      text: '已经完成第一轮设计。',
      createdAt: '2026-07-14T10:00:02.000Z'
    });

    const recent = store.listRecent(workspace);
    expect(recent).toEqual([
      expect.objectContaining({
        id: created.id,
        title: '把登录流程做成产品级实现',
        preview: '已经完成第一轮设计。',
        messageCount: 2
      })
    ]);

    const eventFiles = findEventFiles(join(root, '.kross', 'sessions'));
    expect(eventFiles).toHaveLength(1);
    const events = readFileSync(eventFiles[0]!, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { seq: number; type: string });
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.type)).toEqual([
      'session.created',
      'message.upserted',
      'message.upserted'
    ]);
    expect(readFileSync(join(root, '.kross', 'session-store.db')).length).toBeGreaterThan(0);
    store.close();
  });

  it('coalesces unchanged snapshots and restores updated visible messages', () => {
    const { workspace, store } = createStore();
    const created = store.createSession(workspace);
    const thinking = {
      id: 1,
      from: 'thinking' as const,
      text: '先检查入口',
      createdAt: '2026-07-14T10:00:01.000Z'
    };

    store.upsertMessage(created.id, thinking);
    store.upsertMessage(created.id, thinking);
    store.upsertMessage(created.id, {
      ...thinking,
      durationMs: 1200,
      expanded: false
    });

    const restored = store.loadSession(workspace, created.id);
    expect(restored?.messages).toEqual([
      expect.objectContaining({
        id: 1,
        from: 'thinking',
        durationMs: 1200,
        expanded: false
      })
    ]);
    expect(restored?.summary.messageCount).toBe(1);
    store.close();
  });

  it('rebuilds a deleted SQLite projection from JSONL', () => {
    const { root, workspace, store } = createStore();
    const created = store.createSession(workspace);
    store.upsertMessage(created.id, {
      id: 1,
      from: 'user',
      text: '> 可恢复会话'
    });
    store.close();

    rmSync(join(root, '.kross', 'session-store.db'), { force: true });
    rmSync(join(root, '.kross', 'session-store.db-wal'), { force: true });
    rmSync(join(root, '.kross', 'session-store.db-shm'), { force: true });

    const rebuilt = new HybridSessionStore({ krossHome: join(root, '.kross') });
    expect(rebuilt.listRecent(workspace)).toEqual([
      expect.objectContaining({ id: created.id, title: '可恢复会话' })
    ]);
    expect(rebuilt.loadSession(workspace, created.id)?.messages).toHaveLength(1);
    rebuilt.close();
  });

  it('heals an incomplete JSONL tail before appending later events', () => {
    const { root, workspace, store } = createStore();
    const created = store.createSession(workspace);
    store.upsertMessage(created.id, { id: 1, from: 'user', text: '> first' });
    store.close();

    const [eventPath] = findEventFiles(join(root, '.kross', 'sessions'));
    appendFileSync(eventPath!, '{"schemaVersion":1,"broken"', 'utf8');

    const reopened = new HybridSessionStore({ krossHome: join(root, '.kross') });
    expect(reopened.loadSession(workspace, created.id)?.messages).toHaveLength(1);
    reopened.upsertMessage(created.id, {
      id: 2,
      from: 'agent',
      text: 'second survives'
    });

    expect(reopened.loadSession(workspace, created.id)?.messages).toEqual([
      expect.objectContaining({ id: 1, text: '> first' }),
      expect.objectContaining({ id: 2, text: 'second survives' })
    ]);
    reopened.close();
  });

  it('keeps recent sessions isolated by workspace and supports unique id prefixes', () => {
    const { root, workspace, store } = createStore();
    const otherWorkspace = join(root, 'other');
    mkdirSync(otherWorkspace);
    const first = store.createSession(workspace);
    const second = store.createSession(otherWorkspace);

    store.upsertMessage(first.id, { id: 1, from: 'user', text: '> first' });
    store.upsertMessage(second.id, { id: 1, from: 'user', text: '> second' });

    expect(store.listRecent(workspace).map((session) => session.id)).toEqual([
      first.id
    ]);
    expect(store.loadSession(workspace, first.id.slice(0, 18))?.summary.id).toBe(
      first.id
    );
    expect(store.loadSession(workspace, second.id)).toBeNull();
    store.close();
  });

  it('persists and restores the governed context checkpoint from JSONL', () => {
    const { root, workspace, store } = createStore();
    const created = store.createSession(workspace);
    const context = new SessionContext();
    context.getThread().addCompaction('important prior decision');
    context.beginTurn('continue from checkpoint');
    context.appendAssistant('done');
    context.commitTurn();

    store.upsertMessage(created.id, {
      id: 1,
      from: 'user',
      text: '> continue from checkpoint'
    });
    store.upsertContextState(created.id, context.exportState(), 1);
    store.close();

    const reopened = new HybridSessionStore({ krossHome: join(root, '.kross') });
    const restored = reopened.loadSession(workspace, created.id);
    expect(restored?.contextState?.thread.entries[0]?.kind).toBe('compaction');

    const restoredContext = new SessionContext();
    expect(restoredContext.restoreState(restored!.contextState!)).toBe(true);
    expect(restoredContext.getThread().buildMessages()[0]?.content).toContain(
      'important prior decision'
    );
    reopened.close();
  });

  it('falls back to visible history when the context checkpoint is stale', () => {
    const { root, workspace, store } = createStore();
    const created = store.createSession(workspace);
    const context = new SessionContext();
    context.beginTurn('first');
    context.appendAssistant('first answer');
    context.commitTurn();
    store.upsertMessage(created.id, { id: 1, from: 'user', text: '> first' });
    store.upsertContextState(created.id, context.exportState(), 1);
    store.upsertMessage(created.id, {
      id: 2,
      from: 'agent',
      text: 'newer than checkpoint'
    });
    store.close();

    const reopened = new HybridSessionStore({ krossHome: join(root, '.kross') });
    expect(reopened.loadSession(workspace, created.id)?.contextState).toBeUndefined();
    reopened.close();
  });
});

function createStore(): {
  root: string;
  workspace: string;
  store: HybridSessionStore;
} {
  const root = mkdtempSync(join(tmpdir(), 'kross-session-'));
  temporaryRoots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  let counter = 0;
  const store = new HybridSessionStore({
    krossHome: join(root, '.kross'),
    now: () => new Date(`2026-07-14T10:00:0${Math.min(counter, 9)}.000Z`),
    createSessionId: () => `session-test-${++counter}`
  });
  return { root, workspace, store };
}

function findEventFiles(root: string): string[] {
  const result: string[] = [];
  for (const workspace of readdirDirectories(root)) {
    for (const session of readdirDirectories(workspace)) {
      result.push(join(session, 'events.jsonl'));
    }
  }
  return result;
}

function readdirDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}
