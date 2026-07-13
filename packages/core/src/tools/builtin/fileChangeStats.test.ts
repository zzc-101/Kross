import { describe, expect, it } from 'vitest';

import {
  countLines,
  formatLineDelta,
  hunkLineStats,
  lineDiffStats
} from './fileChangeStats';

describe('fileChangeStats', () => {
  it('counts lines without trailing-empty from final newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\n\nb')).toBe(3);
  });

  it('computes hunk stats for Edit blocks', () => {
    expect(hunkLineStats('foo', 'bar')).toEqual({
      linesAdded: 1,
      linesRemoved: 1
    });
    expect(hunkLineStats('a\nb', 'a\nb\nc', 2)).toEqual({
      linesAdded: 6,
      linesRemoved: 4
    });
  });

  it('computes line-level diff for Write overwrite', () => {
    const before = 'a\nb\nc\n';
    const after = 'a\nx\nc\n';
    expect(lineDiffStats(before, after)).toEqual({
      linesAdded: 1,
      linesRemoved: 1
    });
  });

  it('formats deltas', () => {
    expect(formatLineDelta({ linesAdded: 3, linesRemoved: 1 })).toBe('+3 -1');
    expect(formatLineDelta({ linesAdded: 2, linesRemoved: 0 })).toBe('+2');
    expect(formatLineDelta({ linesAdded: 0, linesRemoved: 4 })).toBe('-4');
    expect(formatLineDelta({ linesAdded: 0, linesRemoved: 0 })).toBe('±0');
  });
});
