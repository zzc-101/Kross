import { describe, expect, it } from 'vitest';

import { createLlmClient } from './createLlmClient';
import { handleModelCommand } from './modelCommand';
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk } from './types';

describe('handleModelCommand', () => {
  it('shows the retained direct-switch usage when model id is missing', () => {
    const result = handleModelCommand(undefined, undefined);
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.text).toContain('/model <modelId>');
    }
  });

  it('switches model on the current client', () => {
    const client = createLlmClient({
      provider: 'openai',
      apiKey: 'key',
      model: 'gpt-a'
    });
    const result = handleModelCommand('gpt-b', client);
    expect(result.kind).toBe('set-model');
    expect(client.model).toBe('gpt-b');
    if (result.kind === 'set-model') {
      expect(result.model).toBe('gpt-b');
      expect(result.text).toContain('gpt-b (high)');
    }
  });

  it('rejects the removed provider plus model syntax', () => {
    const current = new StubClient();
    const result = handleModelCommand('xai grok-3-mini', current);
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.text).toContain('/model <modelId>');
    }
    expect(current.model).toBe('stub');
  });

  it('rejects removed effort subcommands without changing model or effort', () => {
    const current = new StubClient();
    current.thinkingEffort = 'medium';
    const result = handleModelCommand('high', current);
    expect(result.kind).toBe('message');
    expect(current.model).toBe('stub');
    expect(current.thinkingEffort).toBe('medium');
  });

  it('rejects removed textual list aliases', () => {
    const current = new StubClient();
    expect(handleModelCommand('list', current).kind).toBe('message');
    expect(handleModelCommand('providers', current).kind).toBe('message');
    expect(current.model).toBe('stub');
  });

  it('requires a configured current client', () => {
    const result = handleModelCommand('gpt-b', undefined);
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.text).toContain('当前未配置 LLM');
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
