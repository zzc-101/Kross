import { describe, expect, it } from 'vitest';

import {
  balancedTruncate,
  buildCreateDiffPreview,
  buildOverwriteDiffPreview,
  buildReplaceDiffPreview,
  lineDiffUnified,
  lineDiffWithContext
} from './diffPreview';

describe('diffPreview', () => {
  it('builds replace hunk as -old then +new with stats', () => {
    const preview = buildReplaceDiffPreview('a\nb', 'a\nc\nd');
    expect(preview.stats).toEqual({ added: 3, removed: 2 });
    expect(preview.hunks).toHaveLength(1);
    expect(preview.lines.filter((l) => l.op === 'del')).toHaveLength(2);
    expect(preview.lines.filter((l) => l.op === 'add')).toHaveLength(3);
    expect(preview.truncated).toBe(false);
  });

  it('includes surrounding context and line numbers when fileContent is provided', () => {
    const file = ['alpha', 'beta', 'old1', 'old2', 'gamma', 'delta'].join('\n');
    const preview = buildReplaceDiffPreview('old1\nold2', 'new1\nnew2', {
      fileContent: file,
      contextLines: 2
    });
    expect(preview.lines.some((l) => l.op === 'ctx' && l.text === 'alpha')).toBe(
      true
    );
    expect(preview.lines.some((l) => l.op === 'del' && l.text === 'old1')).toBe(
      true
    );
    expect(preview.lines.some((l) => l.op === 'add' && l.text === 'new1')).toBe(
      true
    );
    // old1 是第 3 行（1-based）
    expect(
      preview.lines.some((l) => l.op === 'del' && l.text === 'old1' && l.lineNo === 3)
    ).toBe(true);
  });

  it('truncates long create previews with meta footer', () => {
    const content = Array.from({ length: 80 }, (_, i) => `line-${i}`).join(
      '\n'
    );
    const preview = buildCreateDiffPreview(content, { maxLines: 10 });
    expect(preview.truncated).toBe(true);
    expect(preview.lines.some((l) => l.op === 'meta')).toBe(true);
    expect(preview.stats.added).toBe(80);
  });

  it('overwrite uses LCS with nearby context', () => {
    const before = 'keep\nold\nkeep2\n';
    const after = 'keep\nnew\nkeep2\n';
    const preview = buildOverwriteDiffPreview(before, after, {
      contextLines: 1
    });
    expect(preview.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: 'ctx', text: 'keep' }),
        expect.objectContaining({ op: 'del', text: 'old' }),
        expect.objectContaining({ op: 'add', text: 'new' }),
        expect.objectContaining({ op: 'ctx', text: 'keep2' })
      ])
    );
    expect(preview.stats).toEqual({ added: 1, removed: 1 });
  });

  it('balancedTruncate keeps both del and add sides', () => {
    const lines = [
      ...Array.from({ length: 30 }, (_, i) => ({
        op: 'del' as const,
        text: `d${i}`
      })),
      ...Array.from({ length: 30 }, (_, i) => ({
        op: 'add' as const,
        text: `a${i}`
      }))
    ];
    const out = balancedTruncate(lines, 11);
    expect(out.truncated).toBe(true);
    expect(out.lines.some((l) => l.op === 'del')).toBe(true);
    expect(out.lines.some((l) => l.op === 'add')).toBe(true);
    expect(out.lines.some((l) => l.op === 'meta')).toBe(true);
  });

  it('lineDiffUnified orders del before add for substitution', () => {
    const lines = lineDiffUnified(['a', 'x', 'c'], ['a', 'y', 'c']);
    expect(lines).toEqual([
      { op: 'del', text: 'x', lineNo: 2 },
      { op: 'add', text: 'y', lineNo: 2 }
    ]);
  });

  it('lineDiffWithContext inserts gap markers between distant hunks', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const after = ['a', 'B', 'c', 'd', 'e', 'F', 'g'];
    const lines = lineDiffWithContext(before, after, 1);
    expect(lines.some((l) => l.op === 'meta' && l.text === '···')).toBe(true);
  });
});
