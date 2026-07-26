import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EventJournal } from './eventJournal';

describe('EventJournal', () => {
  it('keeps monotonic wire seq while persisting only durable events', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-journal-'));
    const journal = new EventJournal(root);
    const transient = journal.append(
      'w1',
      's1',
      { type: 'request.accepted', requestId: 'r1' },
      'r1'
    );
    const snapshot = journal.append('w1', 's1', {
      type: 'session.snapshot',
      data: snapshotData('s1')
    }, 'r1');
    const delta = journal.append('w1', 's1', {
      type: 'stream',
      data: { type: 'text-delta', text: 'hello' }
    });

    expect(transient.seq).toBeLessThan(snapshot.seq);
    expect(snapshot.seq).toBeLessThan(delta.seq);
    expect(journal.replay('w1', 's1')).toEqual([snapshot]);
    expect(
      readFileSync(join(root, 'w1', 's1.jsonl'), 'utf8')
    ).not.toContain('text-delta');
  });

  it('truncates events older than the latest snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-journal-'));
    const journal = new EventJournal(root);
    journal.append('w1', 's1', {
      type: 'session.updated',
      data: snapshotData('s1').summary
    });
    const latest = journal.append('w1', 's1', {
      type: 'session.snapshot',
      data: snapshotData('s1')
    });

    expect(journal.replay('w1', 's1')).toEqual([latest]);
  });

  it('keeps seq monotonic across a crash after non-persisted deltas', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-journal-seq-'));
    const first = new EventJournal(root);
    first.append('w1', 's1', {
      type: 'session.snapshot',
      data: snapshotData('s1')
    });
    const transient = first.append('w1', 's1', {
      type: 'stream',
      data: { type: 'text-delta', text: 'not persisted' }
    });

    const restarted = new EventJournal(root);
    const recovered = restarted.append('w1', 's1', {
      type: 'session.snapshot',
      data: snapshotData('s1')
    });
    expect(recovered.seq).toBeGreaterThan(transient.seq);
  });

  it('stores completed request responses in a bounded separate index', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-journal-'));
    const journal = new EventJournal(root);
    const accepted = journal.append(
      'w1',
      's1',
      { type: 'request.accepted', requestId: 'r1' },
      'r1'
    );
    journal.completeRequest('w1', 's1', 'r1', [accepted]);

    const restored = new EventJournal(root);
    expect(
      restored.findCompletedRequest('w1', 's1', 'r1')
    ).toEqual([accepted]);
    expect(
      existsSync(join(root, 'w1', 'requests', 's1.json'))
    ).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(root, 'w1', 'requests', 's1.json'), 'utf8')
      )
    ).toMatchObject({ version: 1 });
  });

  it('keeps complete events when a crash leaves a partial json line', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-journal-'));
    const journal = new EventJournal(root);
    journal.append('w1', 's1', {
      type: 'session.updated',
      data: snapshotData('s1').summary
    });
    writeFileSync(join(root, 'w1', 's1.jsonl'), '{"partial":', { flag: 'a' });

    expect(journal.replay('w1', 's1')).toHaveLength(1);
  });

  it('reads legacy request indexes and sequence reservations', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-journal-legacy-'));
    const journal = new EventJournal(root);
    const accepted = journal.append(
      'w1',
      's1',
      { type: 'request.accepted', requestId: 'legacy' },
      'legacy'
    );
    const requestPath = join(root, 'w1', 'requests', 's1.json');
    mkdirSync(join(root, 'w1', 'requests'), { recursive: true });
    writeFileSync(
      requestPath,
      JSON.stringify([{
        requestId: 'legacy',
        completedAt: new Date().toISOString(),
        events: [accepted]
      }])
    );
    writeFileSync(join(root, 'w1', 'sequences', 's1.seq'), '20000\n');

    const restored = new EventJournal(root);
    expect(restored.findCompletedRequest('w1', 's1', 'legacy')).toEqual([
      accepted
    ]);
    expect(restored.lastSeq('w1', 's1')).toBeGreaterThanOrEqual(20000);
  });

  it('rejects future event, request-index, and sequence versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-journal-future-'));
    const journal = new EventJournal(root);
    const event = journal.append('w1', 's1', {
      type: 'session.snapshot',
      data: snapshotData('s1')
    });
    const eventPath = join(root, 'w1', 's1.jsonl');
    writeFileSync(
      eventPath,
      `${JSON.stringify({ ...event, protocolVersion: 2 })}\n`
    );
    expect(() => new EventJournal(root).replay('w1', 's1')).toThrow(
      'Worker event journal 使用不受支持的数据版本 2'
    );

    const requestPath = join(root, 'w1', 'requests', 's1.json');
    mkdirSync(join(root, 'w1', 'requests'), { recursive: true });
    writeFileSync(requestPath, JSON.stringify({ version: 2, requests: [] }));
    expect(() =>
      new EventJournal(root).findCompletedRequest('w1', 's1', 'r1')
    ).toThrow('Worker request index 使用不受支持的数据版本 2');

    const sequencePath = join(root, 'w1', 'sequences', 's2.seq');
    writeFileSync(sequencePath, JSON.stringify({ version: 2, limit: 10 }));
    expect(() => new EventJournal(root).lastSeq('w1', 's2')).toThrow(
      'Worker sequence reservation 使用不受支持的数据版本 2'
    );
  });
});

function snapshotData(sessionId: string) {
  const timestamp = new Date().toISOString();
  return {
    summary: {
      id: sessionId,
      title: 'Session',
      preview: '',
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0
    },
    messages: [],
    todos: [],
    traces: [],
    mode: 'auto' as const,
    permissionMode: 'default' as const
  };
}
