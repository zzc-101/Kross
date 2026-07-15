import { describe, expect, it } from 'vitest';

import type { LlmClient, LlmRequest } from '../llm/types';
import {
  buildExtractiveTurnSummary,
  ExtractiveSummarizer,
  LlmSummarizer
} from './summarizer';
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
    expect(summary).toContain('auth.ts');
  });

  it('extractive summarizer returns non-empty fallback', async () => {
    const summarizer = new ExtractiveSummarizer();
    const text = await summarizer.summarizeTurns([]);
    expect(text.length).toBeGreaterThan(0);
  });

  it('passes previous summary, detailed history and custom instructions to LLM', async () => {
    let captured: LlmRequest | undefined;
    const client: LlmClient = {
      provider: 'openai',
      async complete(request) {
        captured = request;
        return { provider: 'openai', model: 'test', text: 'merged', raw: {} };
      },
      async *stream() {
        yield { type: 'done' } as const;
      }
    };
    const longDetail = `start-${'x'.repeat(500)}-important-tail`;
    const entries: ThreadEntry[] = [
      {
        id: 'e1',
        turnId: 't1',
        kind: 'assistant',
        message: { role: 'assistant', content: longDetail },
        tokensEst: 100
      }
    ];

    const text = await new LlmSummarizer(client).summarizeTurns(
      [{ turnId: 't1', entries }],
      { previousSummary: 'old decisions', instructions: '保留所有文件名' }
    );

    expect(text).toBe('merged');
    expect(captured?.messages.at(-1)?.content).toContain('old decisions');
    expect(captured?.messages.at(-1)?.content).toContain('important-tail');
    expect(captured?.messages.at(-1)?.content).toContain('保留所有文件名');
  });

  it('keeps previous summary and new facts when the LLM summarizer fails', async () => {
    const client: LlmClient = {
      provider: 'openai',
      async complete() {
        throw new Error('offline');
      },
      async *stream() {
        yield { type: 'done' } as const;
      }
    };
    const entries: ThreadEntry[] = [
      {
        id: 'e1',
        turnId: 't1',
        kind: 'user',
        message: { role: 'user', content: 'new requirement' },
        tokensEst: 10
      }
    ];

    const text = await new LlmSummarizer(client).summarizeTurns(
      [{ turnId: 't1', entries }],
      { previousSummary: 'old decision' }
    );
    expect(text).toContain('old decision');
    expect(text).toContain('new requirement');
  });

  it('forwards cancellation to compaction LLM and does not fall back after abort', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const client: LlmClient = {
      provider: 'openai',
      async complete(request) {
        capturedSignal = request.signal;
        return new Promise((_, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(request.signal?.reason),
            { once: true }
          );
        });
      },
      async *stream() {
        yield { type: 'done' } as const;
      }
    };
    const entries: ThreadEntry[] = [
      {
        id: 'e1',
        turnId: 't1',
        kind: 'user',
        message: { role: 'user', content: 'old task' },
        tokensEst: 10
      }
    ];

    const compacting = new LlmSummarizer(client).summarizeTurns(
      [{ turnId: 't1', entries }],
      { signal: controller.signal }
    );
    controller.abort(new Error('cancel compaction'));

    await expect(compacting).rejects.toThrow('cancel compaction');
    expect(capturedSignal).toBe(controller.signal);
  });
});
