import { describe, expect, it } from 'vitest';

import type { ChatMessage } from './MessageLine';
import {
  estimateMessageRows,
  layoutFingerprint,
  markdownToVisualLines
} from './messageLayout';

function msg(
  partial: Pick<ChatMessage, 'id' | 'from' | 'text'> & Partial<ChatMessage>
): ChatMessage {
  return {
    id: partial.id,
    from: partial.from,
    text: partial.text,
    expanded: partial.expanded
  };
}

describe('estimateMessageRows', () => {
  it('estimates tall agent messages by wrapped lines', () => {
    const long = 'x'.repeat(400);
    const rows = estimateMessageRows(
      msg({ id: 1, from: 'agent', text: long }),
      40
    );
    expect(rows).toBeGreaterThan(10);
  });

  it('counts collapsed thinking as a short summary', () => {
    const rows = estimateMessageRows(
      msg({
        id: 1,
        from: 'thinking',
        text: Array.from({ length: 40 }, (_, i) => `t-${i}`).join('\n')
      }),
      80
    );
    expect(rows).toBe(2);
  });

  it('counts expanded thinking body', () => {
    const text = Array.from({ length: 10 }, (_, i) => `t-${i}`).join('\n');
    const collapsed = estimateMessageRows(
      msg({ id: 1, from: 'thinking', text }),
      80
    );
    const expanded = estimateMessageRows(
      msg({ id: 1, from: 'thinking', text, expanded: true }),
      80
    );
    expect(expanded).toBeGreaterThan(collapsed);
  });

  it('layoutFingerprint changes when thinking expands', () => {
    const base = msg({ id: 1, from: 'thinking', text: 'abc' });
    const open = { ...base, expanded: true as const };
    expect(layoutFingerprint(base)).not.toBe(layoutFingerprint(open));
  });
});

describe('markdownToVisualLines', () => {
  it('expands GFM tables to box-drawing lines', () => {
    const lines = markdownToVisualLines(
      ['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n')
    );
    expect(lines.some((line) => line.includes('┌'))).toBe(true);
    expect(lines.some((line) => line.includes('A'))).toBe(true);
  });
});
