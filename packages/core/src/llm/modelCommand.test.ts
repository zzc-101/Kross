import { describe, expect, it } from 'vitest';

import { createLlmClient } from './createLlmClient';
import { handleModelCommand } from './modelCommand';
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk } from './types';

describe('handleModelCommand', () => {
  it('reports no model when client is missing', () => {
    const result = handleModelCommand(undefined, undefined, {});
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.text).toContain('no model');
    }
  });

  it('lists providers and marks configured ones', () => {
    const result = handleModelCommand('list', undefined, {
      OPENROUTER_API_KEY: 'k',
      OPENROUTER_MODEL: 'openai/gpt-4o-mini'
    });
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.text).toContain('openrouter');
      expect(result.text).toContain('✓');
      expect(result.text).toContain('model=openai/gpt-4o-mini');
    }
  });

  it('switches model on the current client', () => {
    const client = createLlmClient({
      provider: 'openai',
      apiKey: 'key',
      model: 'gpt-a'
    });
    const result = handleModelCommand('gpt-b', client, {});
    expect(result.kind).toBe('set-model');
    expect(client.model).toBe('gpt-b');
    if (result.kind === 'set-model') {
      expect(result.model).toBe('gpt-b');
      expect(result.text).toContain('openai/gpt-b');
    }
  });

  it('creates a client when switching provider with env credentials', () => {
    const current = createLlmClient({
      provider: 'openai',
      apiKey: 'key',
      model: 'gpt-a'
    });
    const result = handleModelCommand('deepseek deepseek-chat', current, {
      DEEPSEEK_API_KEY: 'ds-key',
      DEEPSEEK_MODEL: 'deepseek-chat'
    });
    expect(result.kind).toBe('replace-client');
    if (result.kind === 'replace-client') {
      expect(result.provider).toBe('deepseek');
      expect(result.model).toBe('deepseek-chat');
      expect(result.client.provider).toBe('deepseek');
    }
  });

  it('errors when switching provider without credentials', () => {
    const current = new StubClient();
    const result = handleModelCommand('xai grok-3-mini', current, {});
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.text).toMatch(/密钥|XAI/i);
    }
  });
});

class StubClient implements LlmClient {
  readonly provider = 'openai' as const;
  model = 'stub';

  setModel(model: string): void {
    this.model = model;
  }

  async complete(_request: LlmRequest): Promise<LlmResponse> {
    return {
      provider: this.provider,
      model: this.model,
      text: 'ok',
      raw: {}
    };
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
  }
}
