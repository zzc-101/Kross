import { describe, expect, it } from 'vitest';

import { formatThinkingLabel } from './MessageLine';

describe('formatThinkingLabel', () => {
  it('shows Thought for Ns when duration known', () => {
    expect(
      formatThinkingLabel({ text: 'x', durationMs: 8200 }, false)
    ).toBe('Thought for 8s');
  });

  it('shows Thinking… while streaming', () => {
    expect(formatThinkingLabel({ text: 'x' }, true, '⠋')).toContain(
      'Thinking…'
    );
  });

  it('falls back to Thought without duration', () => {
    expect(formatThinkingLabel({ text: 'x' }, false)).toBe('Thought');
  });
});
