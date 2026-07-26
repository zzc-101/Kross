import { describe, expect, it } from 'vitest';

import {
  classifyLlmError,
  withLlmObservability
} from './providerObservability';
import {
  LlmProviderError,
  type LlmClient,
  type LlmRequest,
  type LlmStreamChunk
} from './types';

describe('LLM provider observability', () => {
  it('records content-free usage and latency for complete and stream calls', async () => {
    const client = withLlmObservability(new ScriptedClient(), clock(10, 25, 30, 52));
    await client.complete({ messages: [{ role: 'user', content: 'secret' }] });
    expect(client.lastCallMetrics).toEqual({
      version: 1,
      provider: 'openai',
      model: 'test-model',
      status: 'completed',
      durationMs: 15,
      rateLimited: false,
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        estimatedCostUsd: 0.001
      }
    });
    expect(JSON.stringify(client.lastCallMetrics)).not.toContain('secret');

    for await (const _chunk of client.stream({ messages: [] })) {
      // consume
    }
    expect(client.lastCallMetrics).toMatchObject({
      status: 'completed',
      durationMs: 22,
      usage: { totalTokens: 2 }
    });
  });

  it('classifies rate limits without retaining provider response bodies', async () => {
    const inner = new ScriptedClient();
    inner.fail = new LlmProviderError(
      'request failed',
      'openai',
      429,
      'sensitive response body'
    );
    const client = withLlmObservability(inner, clock(1, 3));
    await expect(client.complete({ messages: [] })).rejects.toThrow();
    expect(client.lastCallMetrics).toMatchObject({
      status: 'failed',
      errorCategory: 'rate-limit',
      rateLimited: true
    });
    expect(JSON.stringify(client.lastCallMetrics)).not.toContain('sensitive');
    expect(classifyLlmError(new TypeError('fetch failed'))).toBe('network');
  });
});

class ScriptedClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly model = 'test-model';
  fail?: Error;

  async complete(_request: LlmRequest) {
    if (this.fail) throw this.fail;
    return {
      provider: this.provider,
      model: this.model,
      text: 'ok',
      raw: {},
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        estimatedCostUsd: 0.001
      }
    };
  }

  async *stream(_request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield {
      type: 'done',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    };
  }
}

function clock(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}
