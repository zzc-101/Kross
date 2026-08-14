import { describe, expect, it } from 'vitest';

import {
  cycleThinkingEffort,
  formatModelEffortLabel,
  parseThinkingEffort
} from './thinkingEffort';

describe('thinkingEffort', () => {
  it('formats model (effort) without provider', () => {
    expect(formatModelEffortLabel('gpt-4o-mini', 'high')).toBe(
      'gpt-4o-mini (high)'
    );
    expect(formatModelEffortLabel(undefined, 'medium')).toBe('no model');
  });

  it('parses aliases', () => {
    expect(parseThinkingEffort('OFF')).toBe('off');
    expect(parseThinkingEffort('none')).toBe('off');
    expect(parseThinkingEffort('max')).toBe('xhigh');
    expect(parseThinkingEffort('medium')).toBe('medium');
    expect(parseThinkingEffort('nope')).toBeUndefined();
  });

  it('cycles through levels', () => {
    expect(cycleThinkingEffort('off')).toBe('minimal');
    expect(cycleThinkingEffort('high')).toBe('xhigh');
    expect(cycleThinkingEffort('xhigh')).toBe('off');
  });
});
