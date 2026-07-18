import { describe, expect, it } from 'vitest';

import {
  createPiAiModels,
  listPiAiBuiltinModels,
  resolvePiAiModel
} from './piAiModels';
import {
  getLlmProviderDefinition,
  type LlmProvider
} from './llmProviders';

describe('piAiModels', () => {
  it('uses pi-ai catalog protocol and metadata for known models', () => {
    const models = createPiAiModels('openai');
    const model = resolvePiAiModel(models, 'openai', 'gpt-4o', { env: {} });

    expect(model.api).toBe('openai-responses');
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(16_384);
    expect(model.reasoning).toBe(false);
  });

  it('keeps private model ids on the same pi-ai provider protocol', () => {
    const models = createPiAiModels('deepseek');
    const model = resolvePiAiModel(models, 'deepseek', 'private-chat', {
      baseUrl: 'https://gateway.example/v1/',
      env: {}
    });

    expect(model.id).toBe('private-chat');
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('https://gateway.example/v1');
    expect(model.contextWindow).toBe(256_000);
  });

  it('uses pi-ai completions for OpenAI-compatible custom gateways', () => {
    const models = createPiAiModels('openai', {
      baseUrl: 'https://gateway.example/v1'
    });
    const model = resolvePiAiModel(models, 'openai', 'gpt-4o', {
      baseUrl: 'https://gateway.example/v1',
      env: {}
    });

    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('https://gateway.example/v1');
  });

  it('honors an explicit Responses protocol for a custom OpenAI gateway', () => {
    const models = createPiAiModels('openai', {
      baseUrl: 'https://muyuan.do/v1'
    });
    const model = resolvePiAiModel(models, 'openai', 'gpt-5.6', {
      baseUrl: 'https://muyuan.do/v1',
      wireApi: 'responses',
      env: {}
    });

    expect(model.api).toBe('openai-responses');
    expect(model.baseUrl).toBe('https://muyuan.do/v1');
  });

  it('does not mix ambient API keys with explicit header auth', async () => {
    const models = createPiAiModels('anthropic', { headerAuth: true });
    const model = resolvePiAiModel(
      models,
      'anthropic',
      'claude-sonnet-4-5',
      { env: {} }
    );

    await expect(models.getAuth(model)).resolves.toBeUndefined();
  });

  it('applies explicit context window over catalog metadata', () => {
    const models = createPiAiModels('anthropic');
    const model = resolvePiAiModel(models, 'anthropic', 'claude-sonnet-4-5', {
      contextWindow: 384_000,
      env: {}
    });

    expect(model.contextWindow).toBe(384_000);
  });

  it('keeps curated choices present in the installed pi-ai catalog', () => {
    const providers: LlmProvider[] = [
      'openai',
      'anthropic',
      'openrouter',
      'deepseek',
      'xai'
    ];

    for (const provider of providers) {
      const ids = new Set(listPiAiBuiltinModels(provider).map((model) => model.id));
      for (const id of getLlmProviderDefinition(provider).recommendedModels) {
        expect(ids.has(id), `${provider}/${id}`).toBe(true);
      }
    }
  });
});
