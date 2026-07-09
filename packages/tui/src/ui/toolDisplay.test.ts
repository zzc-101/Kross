import { describe, expect, it } from 'vitest';

import {
  buildToolState,
  extractToolPath,
  formatToolTitle,
  isAggregatableTool,
  mergeToolItem
} from './toolDisplay';

describe('toolDisplay', () => {
  it('detects aggregatable read tools', () => {
    expect(isAggregatableTool('Read')).toBe(true);
    expect(isAggregatableTool('Bash')).toBe(false);
  });

  it('extracts path from json input preview', () => {
    expect(extractToolPath(JSON.stringify({ path: 'src/a.ts' }))).toBe('src/a.ts');
  });

  it('formats Read N files title', () => {
    const state = buildToolState('Read', 'read', [
      { path: 'a.ts', status: 'completed' },
      { path: 'b.ts', status: 'completed' },
      { path: 'c.ts', status: 'completed' }
    ]);
    expect(formatToolTitle(state)).toBe('Read 3 files');
  });

  it('merges items by callId', () => {
    const items = mergeToolItem(
      [{ callId: '1', path: 'a.ts', status: 'running' }],
      { callId: '1', path: 'a.ts', status: 'completed', durationMs: 12 }
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('completed');
    expect(items[0]?.durationMs).toBe(12);
  });
});
