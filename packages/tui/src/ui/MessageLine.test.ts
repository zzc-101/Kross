import { describe, expect, it } from 'vitest';

import { collapseThinking, isThinkingCollapsible } from './MessageLine';

describe('collapseThinking', () => {
  it('keeps short thinking intact', () => {
    const result = collapseThinking('step 1\nstep 2', false);
    expect(result.visibleLines).toEqual(['step 1', 'step 2']);
    expect(result.hiddenCount).toBe(0);
  });

  it('collapses long thinking by default', () => {
    const text = Array.from({ length: 20 }, (_, index) => `think-${index}`).join('\n');
    expect(isThinkingCollapsible(text)).toBe(true);
    const result = collapseThinking(text, false);
    expect(result.visibleLines.length).toBeLessThan(20);
    expect(result.hiddenCount).toBeGreaterThan(0);
  });

  it('does not collapse when expanded', () => {
    const text = Array.from({ length: 20 }, (_, index) => `think-${index}`).join('\n');
    const result = collapseThinking(text, true);
    expect(result.visibleLines).toHaveLength(20);
    expect(result.hiddenCount).toBe(0);
  });

  it('truncates single-line overlong thinking and reports hidden content', () => {
    const text = 'x'.repeat(500);
    expect(isThinkingCollapsible(text)).toBe(true);
    const result = collapseThinking(text, false);
    expect(result.visibleLines).toHaveLength(1);
    expect(result.visibleLines[0]?.endsWith('…')).toBe(true);
    expect((result.visibleLines[0] ?? '').length).toBeLessThan(text.length);
    expect(result.hiddenCount).toBeGreaterThan(0);
  });
});
