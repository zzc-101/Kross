import { describe, expect, it } from 'vitest';

import type { ContextInspection, ContextMaintenanceResult } from '@kross/core';

import { formatCompactResult, formatContextInspection } from './appCommands';

function sampleSnapshot(): ContextInspection {
  return {
    mode: 'normal',
    messages: [],
    includedSources: ['session-todos'],
    droppedSources: ['repo-map'],
    pinnedSources: ['session-todos'],
    estimatedTokens: 12_400,
    estimatedChars: 49_600,
    inputBudget: 224_000,
    compactThreshold: 179_200,
    report: {
      totalTokens: 12_400,
      totalChars: 49_600,
      sections: {
        system: 3200,
        thread: 6800,
        history: 6800,
        sources: 1200,
        skills: 400,
        tools: 800
      },
      contributors: []
    }
  };
}

describe('formatContextInspection', () => {
  it('renders token-oriented aligned context block', () => {
    const maintenance: ContextMaintenanceResult[] = [
      {
        compacted: true,
        stage: 'turn-compaction',
        reason: 'turn_compaction',
        droppedMessageCount: 6,
        droppedTurnCount: 2,
        preservedMessageCount: 4,
        tokensBefore: 45_200,
        tokensAfter: 18_100,
        historyCharsBefore: 180_800,
        historyCharsAfter: 72_400,
        at: '2026-07-15T10:30:00.000Z'
      }
    ];

    const text = formatContextInspection(sampleSnapshot(), maintenance, {
      lastUsageTokens: 10_500
    });

    expect(text).toContain('Context');
    expect(text).toContain('mode: normal');
    expect(text).toContain('预估 token: 12.4K / 224K');
    expect(text).toContain('压缩阈值: 179.2K');
    expect(text).toContain('上次请求 input: 10.5K');
    expect(text).toContain('system   3.2K');
    expect(text).toContain('thread   6.8K');
    expect(text).toContain('included: session-todos');
    expect(text).toContain('dropped:  repo-map');
    expect(text).toContain('pinned:   session-todos');
    expect(text).toContain('Stage2');
    expect(text).toContain('45.2K -> 18.1K');
  });
});

describe('formatCompactResult', () => {
  it('summarizes a successful manual compaction', () => {
    const text = formatCompactResult(
      {
        compacted: true,
        stage: 'turn-compaction',
        reason: 'manual',
        droppedMessageCount: 8,
        droppedTurnCount: 3,
        preservedMessageCount: 5,
        tokensBefore: 52_000,
        tokensAfter: 21_000,
        historyCharsBefore: 208_000,
        historyCharsAfter: 84_000
      },
      4
    );

    expect(text).toContain('已压缩 3 轮');
    expect(text).toContain('52K -> 21K');
    expect(text).toContain('Stage2');
  });

  it('reports nothing to compact when preserve window blocks it', () => {
    const text = formatCompactResult(
      {
        compacted: false,
        reason: 'manual',
        droppedMessageCount: 0,
        preservedMessageCount: 3,
        tokensBefore: 4000,
        tokensAfter: 4000,
        historyCharsBefore: 16_000,
        historyCharsAfter: 16_000
      },
      4
    );

    expect(text).toContain('无可压缩内容');
    expect(text).toContain('4');
  });
});
