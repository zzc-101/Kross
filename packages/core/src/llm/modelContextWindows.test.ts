import { describe, expect, it } from 'vitest';

import {
  estimateTokensFromChars,
  formatCompactCount,
  formatContextUsage,
  resolveModelContextWindow
} from './modelContextWindows';

describe('modelContextWindows', () => {
  it('resolves known model windows and env override', () => {
    expect(resolveModelContextWindow('claude-sonnet-4-5', {})).toBe(200_000);
    expect(resolveModelContextWindow('gpt-4o', {})).toBe(128_000);
    expect(resolveModelContextWindow('gemini-2.5-pro', {})).toBe(1_000_000);
    expect(
      resolveModelContextWindow('gpt-4o', { AGENT_CONTEXT_WINDOW: '1000000' })
    ).toBe(1_000_000);
  });

  it('formats compact token counts and usage pairs', () => {
    expect(formatCompactCount(267_000)).toBe('267K');
    expect(formatCompactCount(1_000_000)).toBe('1M');
    expect(formatCompactCount(12_500)).toBe('12.5K');
    expect(formatContextUsage(12_000, 128_000)).toBe('12K/128K');
    expect(estimateTokensFromChars(400)).toBe(100);
  });
});
