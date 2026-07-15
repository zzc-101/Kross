import { describe, expect, it } from 'vitest';

import {
  buildToolState,
  extractToolPath,
  formatToolTitle,
  isAggregatableTool,
  mergeToolItem,
  parseLineStatsFromSummary
} from './toolDisplay';

describe('toolDisplay', () => {
  it('detects aggregatable read tools', () => {
    expect(isAggregatableTool('Read')).toBe(true);
    expect(isAggregatableTool('Bash')).toBe(false);
  });

  it('extracts path from json input preview', () => {
    expect(extractToolPath(JSON.stringify({ path: 'src/a.ts' }))).toBe('src/a.ts');
  });

  it('extracts path from human Edit/Write preview', () => {
    expect(extractToolPath('src/a.ts · 2 lines · hello')).toBe('src/a.ts');
    expect(
      extractToolPath('src/a.ts · replace_all\n- old\n+ new')
    ).toBe('src/a.ts');
  });

  it('formats Read N files title', () => {
    const state = buildToolState('Read', 'read', [
      { path: 'a.ts', status: 'completed' },
      { path: 'b.ts', status: 'completed' },
      { path: 'c.ts', status: 'completed' }
    ]);
    expect(formatToolTitle(state)).toBe('Read 3 files');
  });

  it('formats Edit/Write title with line stats', () => {
    const edit = buildToolState('Edit', 'write', [
      {
        path: 'src/a.ts',
        status: 'completed',
        summary: 'replaced 1 · +3 -1',
        linesAdded: 3,
        linesRemoved: 1
      }
    ]);
    expect(formatToolTitle(edit)).toBe('Edit src/a.ts +3 -1');

    const write = buildToolState('Write', 'write', [
      {
        path: 'src/b.ts',
        status: 'completed',
        summary: 'created +12',
        linesAdded: 12,
        linesRemoved: 0
      }
    ]);
    expect(formatToolTitle(write)).toBe('Write src/b.ts +12');
  });

  it('parses line stats from summary', () => {
    expect(parseLineStatsFromSummary('replaced 1 · +3 -1')).toEqual({
      linesAdded: 3,
      linesRemoved: 1
    });
    expect(parseLineStatsFromSummary('created +12')).toEqual({
      linesAdded: 12,
      linesRemoved: 0
    });
  });

  it('merges items by callId', () => {
    const items = mergeToolItem(
      [{ callId: '1', path: 'a.ts', status: 'running' }],
      {
        callId: '1',
        path: 'a.ts',
        status: 'completed',
        durationMs: 12,
        linesAdded: 2,
        linesRemoved: 1
      }
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('completed');
    expect(items[0]?.durationMs).toBe(12);
    expect(items[0]?.linesAdded).toBe(2);
    expect(items[0]?.linesRemoved).toBe(1);
  });

  it('keeps a cancelled item as the aggregate terminal status', () => {
    const state = buildToolState('Read', 'read', [
      { path: 'a.ts', status: 'completed' },
      { path: 'b.ts', status: 'cancelled' }
    ]);
    expect(state.status).toBe('cancelled');
  });
});
