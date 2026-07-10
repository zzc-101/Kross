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
      expect(result.text).toContain('gpt-b (medium)');
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

  it('uses the explicit model when provider env only contains an API key', () => {
    const result = handleModelCommand('openai gpt-explicit', undefined, {
      OPENAI_API_KEY: 'key'
    });

    expect(result.kind).toBe('replace-client');
    if (result.kind === 'replace-client') {
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-explicit');
      expect(result.client.model).toBe('gpt-explicit');
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

  it('sets thinking effort via /model <effort>', () => {
    const current = new StubClient();
    current.thinkingEffort = 'medium';
    const result = handleModelCommand('high', current, {});
    expect(result.kind).toBe('set-effort');
    expect(current.thinkingEffort).toBe('high');
  });

  it('cycles thinking effort via /model cycle', () => {
    const current = new StubClient();
    current.thinkingEffort = 'high';
    const result = handleModelCommand('cycle', current, {});
    expect(result.kind).toBe('set-effort');
    if (result.kind === 'set-effort') {
      expect(result.effort).toBe('xhigh');
    }
  });

  it('uses saved kross credentials when env lacks keys', () => {
    const result = handleModelCommand(
      'anthropic claude-test',
      undefined,
      {},
      {
        provider: 'anthropic',
        authToken: 'saved-token',
        model: 'claude-old'
      }
    );
    expect(result.kind).toBe('replace-client');
    if (result.kind === 'replace-client') {
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-test');
    }
  });
});

class StubClient implements LlmClient {
  readonly provider = 'openai' as const;
  model = 'stub';
  thinkingEffort: import('./thinkingEffort').ThinkingEffort = 'medium';

  setModel(model: string): void {
    this.model = model;
  }

  setThinkingEffort(effort: import('./thinkingEffort').ThinkingEffort): void {
    this.thinkingEffort = effort;
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
