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

  it('falls back to a Chinese label without duration', () => {
    expect(formatThinkingLabel({ text: 'x' }, false)).toBe('思考过程');
  });
});
