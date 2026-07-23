import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    mode: 'auto' as const
  };
}
