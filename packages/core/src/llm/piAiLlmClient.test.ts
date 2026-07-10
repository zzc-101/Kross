import { describe, expect, it } from 'vitest';

import {
  normalizeAnthropicBaseUrl,
  normalizeOpenAiBaseUrl,
  PiAiLlmClient
} from './piAiLlmClient';

describe('PiAiLlmClient helpers', () => {
  it('normalizes OpenAI base URLs', () => {
    expect(normalizeOpenAiBaseUrl(undefined)).toBe('https://api.openai.com/v1');
    expect(normalizeOpenAiBaseUrl('https://proxy.example/v1/')).toBe(
      'https://proxy.example/v1'
    );
  });

  it('strips trailing /v1 for Anthropic SDK baseURL', () => {
    expect(normalizeAnthropicBaseUrl(undefined)).toBe(
      'https://api.anthropic.com'
    );
    expect(
      normalizeAnthropicBaseUrl('https://api.anthropic.com/v1')
    ).toBe('https://api.anthropic.com');
    expect(
      normalizeAnthropicBaseUrl('https://ark.example/api/coding/v1/')
    ).toBe('https://ark.example/api/coding');
  });

  it('constructs clients for openai and anthropic configs', () => {
    const openai = new PiAiLlmClient({
      provider: 'openai',
      apiKey: 'key',
      model: 'gpt-test',
      baseUrl: 'https://llm.example/v1'
    });
    expect(openai.provider).toBe('openai');
    expect(openai.model).toBe('gpt-test');

    const anthropic = new PiAiLlmClient({
      provider: 'anthropic',
      authToken: 'token',
      model: 'claude-test',
      baseUrl: 'https://anthropic.example/v1'
    });
    expect(anthropic.provider).toBe('anthropic');
    expect(anthropic.model).toBe('claude-test');
  });
});
