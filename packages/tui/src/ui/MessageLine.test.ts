import { describe, expect, it } from 'vitest';

import {
  collapseThinking,
  formatThinkingLabel,
  isThinkingCollapsible
} from './MessageLine';

describe('collapseThinking', () => {
  it('hides body when collapsed (Claude Code style)', () => {
    const result = collapseThinking('step 1\nstep 2', false);
    expect(result.visibleLines).toEqual([]);
    expect(result.hiddenCount).toBeGreaterThan(0);
  });

  it('always treats thinking as collapsible', () => {
    expect(isThinkingCollapsible('short')).toBe(true);
    expect(isThinkingCollapsible('x'.repeat(500))).toBe(true);
  });

  it('shows full body when expanded', () => {
    const text = Array.from({ length: 20 }, (_, index) => `think-${index}`).join(
      '\n'
    );
    const result = collapseThinking(text, true);
    expect(result.visibleLines).toHaveLength(20);
    expect(result.hiddenCount).toBe(0);
  });
});

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
});
