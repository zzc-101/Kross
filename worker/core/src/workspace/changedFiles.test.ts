import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '../domain';
import {
  extractChangedFilesFromEvents,
  extractTouchedFilesFromEvents,
  findLastFileMutationIndex
} from './changedFiles';

describe('changedFiles', () => {
  it('pairs started.input with completed by callId', () => {
    const events = [
      started('Write', { path: 'src/a.ts' }, 'c1'),
      completed('Write', 'wrote 10 bytes', 'c1'),
      started('Edit', { path: 'src/b.ts' }, 'c2'),
      completed('Edit', 'replaced 1 occurrence(s)', 'c2'),
      started('Edit', { path: 'src/b.ts' }, 'c3'),
      completed('Edit', 'replaced 2 occurrence(s)', 'c3'),
      started('Read', { path: 'src/c.ts' }, 'c4'),
      completed('Read', 'ok', 'c4'),
      started('Write', { path: 'src/a.ts' }, 'c5'),
      completed('Write', 'wrote 20 bytes', 'c5')
    ];

    expect(extractChangedFilesFromEvents(events)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(extractTouchedFilesFromEvents(events)).toEqual([
      { path: 'src/a.ts', tools: ['Write'] },
      { path: 'src/b.ts', tools: ['Edit'] }
    ]);
  });

  it('skips Edit when no mutation occurred', () => {
    const events = [
      started('Edit', { path: 'src/x.ts' }, 'c1'),
      completed('Edit', 'no match', 'c1'),
      started('Edit', { path: 'src/y.ts' }, 'c2'),
      completed('Edit', 'ambiguous: 3 matches', 'c2'),
      started('Edit', { path: 'src/z.ts' }, 'c3'),
      completed('Edit', 'replaced 1 occurrence(s)', 'c3')
    ];

    expect(extractChangedFilesFromEvents(events)).toEqual(['src/z.ts']);
  });

  it('ignores started-only calls and empty paths', () => {
    const events: TraceEvent[] = [
      started('Write', { path: 'src/skip.ts' }, 'only-started'),
      started('Write', { path: '  ' }, 'empty'),
      completed('Write', 'wrote 1 bytes', 'empty')
    ];

    expect(extractChangedFilesFromEvents(events)).toEqual([]);
  });

  it('falls back to path on completed.input when present', () => {
    const events: TraceEvent[] = [
      {
        id: '1',
        runId: 'r',
        type: 'tool_call.completed',
        timestamp: '2026-07-09T10:00:00.000Z',
        payload: {
          toolName: 'Write',
          input: { path: 'legacy.ts' },
          summary: 'wrote 1 bytes'
        }
      }
    ];
    expect(extractChangedFilesFromEvents(events)).toEqual(['legacy.ts']);
  });

  it('extracts ApplyPatch files from completed data and locates the last mutation', () => {
    const events: TraceEvent[] = [
      started('Write', { path: 'src/first.ts' }, 'write-1'),
      completed('Write', 'wrote 1 bytes', 'write-1'),
      started('ApplyPatch', { patch: 'redacted' }, 'patch-1'),
      {
        ...completed('ApplyPatch', '2 files patched', 'patch-1'),
        payload: {
          toolName: 'ApplyPatch',
          callId: 'patch-1',
          summary: '2 files patched',
          data: { files: ['src/a.ts', 'src/b.ts'], updated: 2 }
        }
      }
    ];

    expect(extractChangedFilesFromEvents(events)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/first.ts'
    ]);
    expect(findLastFileMutationIndex(events)).toBe(3);
  });

  it('does not count failed or no-op file calls as mutations', () => {
    const events: TraceEvent[] = [
      started('Edit', { path: 'src/a.ts' }, 'edit-1'),
      completed('Edit', 'no change', 'edit-1'),
      {
        ...completed('Write', 'failed', 'write-1'),
        type: 'tool_call.failed'
      }
    ];

    expect(findLastFileMutationIndex(events)).toBe(-1);
  });
});

function started(
  toolName: string,
  input: Record<string, unknown>,
  callId: string
): TraceEvent {
  return {
    id: `start-${callId}`,
    runId: 'r',
    type: 'tool_call.started',
    timestamp: '2026-07-09T10:00:00.000Z',
    payload: { toolName, input, callId }
  };
}

function completed(toolName: string, summary: string, callId: string): TraceEvent {
  return {
    id: `done-${callId}`,
    runId: 'r',
    type: 'tool_call.completed',
    timestamp: '2026-07-09T10:00:00.000Z',
    payload: { toolName, summary, callId }
  };
}
