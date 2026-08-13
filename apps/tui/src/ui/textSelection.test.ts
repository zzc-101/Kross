import { describe, expect, it } from 'vitest';

import type { PaintItem } from './messagePaint';
import {
  copyPaintSelection,
  highlightPaintSegments,
  resolveViewportSelectionPoint,
  sliceDisplayColumns,
  type TextSelectionRange
} from './textSelection';

const items: PaintItem[] = [
  { kind: 'line', key: '0', height: 1, segments: [{ text: 'hello' }] },
  { kind: 'line', key: '1', height: 1, segments: [{ text: '公益模型' }] },
  { kind: 'line', key: '2', height: 1, segments: [{ text: 'done' }] }
];

describe('textSelection', () => {
  it('copies a forward or reverse multi-line visual range', () => {
    const forward: TextSelectionRange = {
      anchor: { row: 0, col: 2 },
      head: { row: 2, col: 1 }
    };
    expect(copyPaintSelection(items, forward)).toBe('llo\n公益模型\ndo');
    expect(
      copyPaintSelection(items, {
        anchor: forward.head,
        head: forward.anchor
      })
    ).toBe('llo\n公益模型\ndo');
  });

  it('slices CJK text by terminal display columns', () => {
    expect(sliceDisplayColumns('A公益B', 1, 5)).toBe('公益');
  });

  it('marks only the selected cells as inverse', () => {
    const result = highlightPaintSegments(
      [{ text: 'ab', bold: true }, { text: 'cd', color: 'cyan' }],
      { start: 1, end: 3 }
    );
    expect(result.map((segment) => [segment.text, segment.inverse])).toEqual([
      ['a', undefined],
      ['b', true],
      ['c', true],
      ['d', undefined]
    ]);
  });

  it('maps terminal coordinates into absolute painted rows', () => {
    expect(
      resolveViewportSelectionPoint({
        window: {
          items: items.slice(1),
          startRow: 1,
          maxScrollOffset: 1,
          totalRows: 3,
          hasMoreAbove: true,
          hasMoreBelow: false
        },
        contentRows: 4,
        viewportTopRow: 3,
        contentLeftCol: 2,
        terminalRow: 6,
        terminalCol: 4
      })
    ).toEqual({ row: 2, col: 2 });
  });
});
