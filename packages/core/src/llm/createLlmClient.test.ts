import { describe, expect, it } from 'vitest';

import { createLlmClient, createLlmClientFromEnv } from './createLlmClient';
import { AnthropicProtocolClient } from './anthropicProtocolClient';
import { OpenAiProtocolClient } from './openAiProtocolClient';

describe('createLlmClient', () => {
  it('creates OpenAI-compatible clients', () => {
    const client = createLlmClient({
      provider: 'openai',
      apiKey: 'key',
      model: 'gpt-test'
    });

    expect(client).toBeInstanceOf(OpenAiProtocolClient);
  });

  it('creates Anthropic-compatible clients', () => {
    const client = createLlmClient({
      provider: 'anthropic',
      apiKey: 'key',
      model: 'claude-test'
    });

    expect(client).toBeInstanceOf(AnthropicProtocolClient);
  });

  it('returns undefined when env does not configure an LLM provider', () => {
    expect(createLlmClientFromEnv({})).toBeUndefined();
  });

  it('reads OpenAI-compatible settings from env', () => {
    const client = createLlmClientFromEnv({
      AGENT_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'key',
      OPENAI_MODEL: 'gpt-test',
      OPENAI_BASE_URL: 'https://llm.example/v1'
    });

    expect(client).toBeInstanceOf(OpenAiProtocolClient);
  });

  it('reads Anthropic settings from env', () => {
    const client = createLlmClientFromEnv({
      AGENT_LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'key',
      ANTHROPIC_MODEL: 'claude-test',
      ANTHROPIC_BASE_URL: 'https://anthropic.example/v1'
    });

    expect(client).toBeInstanceOf(AnthropicProtocolClient);
  });
});
