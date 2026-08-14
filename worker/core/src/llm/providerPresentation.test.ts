import { describe, expect, it } from 'vitest';

import {
  formatLlmCallMetrics,
  formatLlmCallMetricsCompact,
  formatLlmCapabilities
} from './providerPresentation';

describe('provider presentation', () => {
  it('formats capabilities and bounded call metrics', () => {
    expect(formatLlmCapabilities({
      version: 1,
      source: 'model-catalog',
      toolCalling: true,
      thinking: true,
      structuredOutput: false,
      promptCaching: true,
      multimodalRead: false
    })).toBe(
      'tools=yes · thinking=yes · cache=yes · structured=no · vision=no'
    );
    const metrics = {
      version: 1 as const,
      provider: 'openai' as const,
      model: 'test',
      status: 'completed' as const,
      durationMs: 1250,
      rateLimited: false,
      usage: {
        totalTokens: 12_500,
        cacheReadTokens: 2_000,
        estimatedCostUsd: 0.0042
      }
    };
    expect(formatLlmCallMetrics(metrics)).toContain('12,500 tokens');
    expect(formatLlmCallMetricsCompact(metrics)).toBe(
      '13K tok · 1250ms · 2K cached · $0.0042'
    );
  });
});
