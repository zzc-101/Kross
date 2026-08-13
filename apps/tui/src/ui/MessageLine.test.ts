import { describe, expect, it } from 'vitest';

import { formatThinkingLabel } from './MessageLine';

describe('formatThinkingLabel', () => {
  it('shows Chinese duration when known', () => {
    expect(
      formatThinkingLabel({ text: 'x', durationMs: 8200 }, false)
    ).toBe('思考了 8 秒');
  });

  it('shows a Chinese streaming label', () => {
    expect(formatThinkingLabel({ text: 'x' }, true, '⠋')).toContain(
      '思考中…'
    );
  });

  it('shows accumulated seconds while thinking is streaming', () => {
    expect(
      formatThinkingLabel(
        { text: 'x', createdAt: '2026-07-15T00:00:00.000Z' },
        true,
        undefined,
        new Date('2026-07-15T00:00:03.900Z').getTime()
      )
    ).toBe('思考中… 3 秒');
  });

  it('falls back to a Chinese label without duration', () => {
    expect(formatThinkingLabel({ text: 'x' }, false)).toBe('思考过程');
  });
});
