import { displayWidth } from './markdownParse';
import type { PaintItem, PaintSegment, PaintWindow } from './messagePaint';
import { paintItemPlainText } from './messagePaint';

export interface TextSelectionPoint {
  /** Absolute row in the full painted conversation. */
  row: number;
  /** Zero-based terminal display column within that painted row. */
  col: number;
}

export interface TextSelectionRange {
  anchor: TextSelectionPoint;
  head: TextSelectionPoint;
}

export function resolveViewportSelectionPoint(input: {
  window: PaintWindow;
  contentRows: number;
  viewportTopRow: number;
  contentLeftCol: number;
  terminalRow: number;
  terminalCol: number;
  clamp?: boolean;
}): TextSelectionPoint | undefined {
  if (input.window.items.length === 0) {
    return undefined;
  }
  const contentHeight = input.window.items.length;
  const padTop = Math.max(0, input.contentRows - contentHeight);
  const firstRow = input.viewportTopRow + padTop;
  const lastRow = firstRow + contentHeight - 1;
  if (
    !input.clamp &&
    (input.terminalRow < firstRow || input.terminalRow > lastRow)
  ) {
    return undefined;
  }

  const localRow = Math.max(
    0,
    Math.min(input.terminalRow - firstRow, contentHeight - 1)
  );
  const item = input.window.items[localRow];
  if (!item) {
    return undefined;
  }
  const lineWidth = Math.max(1, displayWidth(paintItemPlainText(item)));
  const localCol = Math.max(0, input.terminalCol - input.contentLeftCol);
  return {
    row: input.window.startRow + localRow,
    col: Math.min(localCol, lineWidth - 1)
  };
}

export function selectionColumnsForRow(
  selection: TextSelectionRange,
  row: number,
  lineWidth: number
): { start: number; end: number } | undefined {
  const [startPoint, endPoint] = normalizeSelection(selection);
  if (row < startPoint.row || row > endPoint.row) {
    return undefined;
  }

  let start = row === startPoint.row ? startPoint.col : 0;
  let end = row === endPoint.row ? endPoint.col + 1 : lineWidth;
  start = Math.max(0, Math.min(start, lineWidth));
  end = Math.max(start, Math.min(end, lineWidth));
  return end > start ? { start, end } : undefined;
}

/** Reconstruct exactly the visible painted text covered by a drag. */
export function copyPaintSelection(
  items: readonly PaintItem[],
  selection: TextSelectionRange
): string {
  const [startPoint, endPoint] = normalizeSelection(selection);
  const rows: string[] = [];
  for (let row = startPoint.row; row <= endPoint.row; row += 1) {
    const item = items[row];
    if (!item) {
      continue;
    }
    const text = paintItemPlainText(item);
    const columns = selectionColumnsForRow(selection, row, displayWidth(text));
    rows.push(columns ? sliceDisplayColumns(text, columns.start, columns.end) : '');
  }
  return rows.join('\n');
}

/** Split styled paint segments and invert only the selected cells. */
export function highlightPaintSegments(
  segments: readonly PaintSegment[],
  columns: { start: number; end: number } | undefined
): PaintSegment[] {
  if (!columns) {
    return [...segments];
  }

  const output: PaintSegment[] = [];
  let cursor = 0;
  for (const segment of segments) {
    let chunk = '';
    let chunkSelected: boolean | undefined;
    const flush = () => {
      if (!chunk) return;
      output.push({
        ...segment,
        text: chunk,
        ...(chunkSelected ? { inverse: true } : {})
      });
      chunk = '';
    };

    for (const char of segment.text) {
      const width = displayWidth(char);
      const selected =
        width === 0
          ? chunkSelected === true
          : cursor < columns.end && cursor + width > columns.start;
      if (chunkSelected !== undefined && selected !== chunkSelected) {
        flush();
      }
      chunkSelected = selected;
      chunk += char;
      cursor += width;
    }
    flush();
  }
  return output;
}

export function sliceDisplayColumns(
  text: string,
  start: number,
  end: number
): string {
  let output = '';
  let cursor = 0;
  for (const char of text) {
    const width = displayWidth(char);
    if (
      width === 0
        ? output.length > 0
        : cursor < end && cursor + width > start
    ) {
      output += char;
    }
    cursor += width;
  }
  return output;
}

function normalizeSelection(
  selection: TextSelectionRange
): [TextSelectionPoint, TextSelectionPoint] {
  return comparePoints(selection.anchor, selection.head) <= 0
    ? [selection.anchor, selection.head]
    : [selection.head, selection.anchor];
}

function comparePoints(a: TextSelectionPoint, b: TextSelectionPoint): number {
  return a.row === b.row ? a.col - b.col : a.row - b.row;
}
