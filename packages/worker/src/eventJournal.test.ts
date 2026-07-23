import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EventJournal } from './eventJournal';

describe('EventJournal', () => {
  it('assigns monotonic seq values and replays only missing events', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-journal-'));
    const journal = new EventJournal(root);
    journal.append('w1', 's1', { type: 'request.accepted', requestId: 'r1' });
    journal.append('w1', 's1', { type: 'request.accepted', requestId: 'r2' });

    expect(journal.replay('w1', 's1', 1).map((event) => event.seq)).toEqual([2]);
    expect(journal.findAcceptedRequest('w1', 's1', 'r2')?.seq).toBe(2);
  });

  it('keeps complete events when a crash leaves a partial json line', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-journal-'));
    const journal = new EventJournal(root);
    journal.append('w1', 's1', { type: 'request.accepted', requestId: 'r1' });
    writeFileSync(join(root, 'w1', 's1.jsonl'), '{"partial":', { flag: 'a' });

    expect(journal.replay('w1', 's1')).toHaveLength(1);
  });
});
