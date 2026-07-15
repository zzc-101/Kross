import { describe, expect, it } from 'vitest';

import { buildExtractiveTurnSummary, ExtractiveSummarizer } from './summarizer';
import type { ThreadEntry } from './conversationThread';

describe('Summarizer', () => {
  it('builds structured extractive summary', () => {
    const entries: ThreadEntry[] = [
      {
        id: 'e1',
        turnId: 't1',
        kind: 'user',
        message: { role: 'user', content: 'fix login bug' },
        tokensEst: 10
      },
      {
        id: 'e2',
        turnId: 't1',
        kind: 'assistant',
        message: {
          role: 'assistant',
          content: 'reading auth module',
          toolCalls: [{ id: 'c1', name: 'Read', input: { path: 'auth.ts' } }]
        },
        tokensEst: 20
      }
    ];
    const summary = buildExtractiveTurnSummary([{ turnId: 't1', entries }]);
    expect(summary).toContain('fix login');
    expect(summary).toContain('Read');
  });

  it('extractive summarizer returns non-empty fallback', async () => {
    const summarizer = new ExtractiveSummarizer();
    const text = await summarizer.summarizeTurns([]);
    expect(text.length).toBeGreaterThan(0);
  });
});
