import { describe, expect, it } from 'vitest';

import { createLlmClient, createLlmClientFromEnv } from './createLlmClient';
import { AnthropicProtocolClient } from './anthropicProtocolClient';
import { OpenAiProtocolClient } from './openAiProtocolClient';
import { PiAiLlmClient } from './piAiLlmClient';

describe('createLlmClient', () => {
  it('defaults to pi-backed clients', () => {
    const openai = createLlmClient({
      provider: 'openai',
      apiKey: 'key',
      model: 'gpt-test'
    });
    expect(openai).toBeInstanceOf(PiAiLlmClient);

    const anthropic = createLlmClient({
      provider: 'anthropic',
      apiKey: 'key',
      model: 'claude-test'
    });
    expect(anthropic).toBeInstanceOf(PiAiLlmClient);

    const openrouter = createLlmClient({
      provider: 'openrouter',
      apiKey: 'key',
      model: 'anthropic/claude-sonnet-4'
    });
    expect(openrouter).toBeInstanceOf(PiAiLlmClient);
    expect(openrouter.provider).toBe('openrouter');
  });

  it('uses native clients when fetch is injected', () => {
    const fetchImpl = async () => new Response('{}');

    const openai = createLlmClient({
      provider: 'openai',
      apiKey: 'key',
      model: 'gpt-test',
      fetch: fetchImpl
    });
    expect(openai).toBeInstanceOf(OpenAiProtocolClient);

    const deepseek = createLlmClient({
      provider: 'deepseek',
      apiKey: 'key',
      model: 'deepseek-chat',
      fetch: fetchImpl
    });
    expect(deepseek).toBeInstanceOf(OpenAiProtocolClient);
    expect(deepseek.provider).toBe('deepseek');

    const anthropic = createLlmClient({
      provider: 'anthropic',
      apiKey: 'key',
      model: 'claude-test',
      fetch: fetchImpl
    });
    expect(anthropic).toBeInstanceOf(AnthropicProtocolClient);
  });

  it('allows forcing native backend', () => {
    const client = createLlmClient({
      provider: 'openai',
      apiKey: 'key',
      model: 'gpt-test',
      backend: 'native'
    });
    expect(client).toBeInstanceOf(OpenAiProtocolClient);
  });

  it('returns undefined when env does not configure an LLM provider', () => {
    expect(createLlmClientFromEnv({})).toBeUndefined();
  });

  it('reads OpenAI-compatible settings from env into pi client', () => {
    const client = createLlmClientFromEnv({
      AGENT_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'key',
      OPENAI_MODEL: 'gpt-test',
      OPENAI_BASE_URL: 'https://llm.example/v1'
    });

    expect(client).toBeInstanceOf(PiAiLlmClient);
    expect(client?.model).toBe('gpt-test');
  });

  it('reads openrouter settings from env', () => {
    const client = createLlmClientFromEnv({
      AGENT_LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'or-key',
      OPENROUTER_MODEL: 'openai/gpt-4o-mini'
    });

    expect(client).toBeInstanceOf(PiAiLlmClient);
    expect(client?.provider).toBe('openrouter');
    expect(client?.model).toBe('openai/gpt-4o-mini');
  });

  it('reads Anthropic settings from env into pi client', () => {
    const client = createLlmClientFromEnv({
      AGENT_LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'key',
      ANTHROPIC_MODEL: 'claude-test',
      ANTHROPIC_BASE_URL: 'https://anthropic.example/v1'
    });

    expect(client).toBeInstanceOf(PiAiLlmClient);
    expect(client?.model).toBe('claude-test');
  });

  it('honors AGENT_LLM_BACKEND=native from env', () => {
    const client = createLlmClientFromEnv({
      AGENT_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'key',
      OPENAI_MODEL: 'gpt-test',
      AGENT_LLM_BACKEND: 'native'
    });

    expect(client).toBeInstanceOf(OpenAiProtocolClient);
  });

  it('rejects unknown providers', () => {
    expect(() =>
      createLlmClientFromEnv({
        AGENT_LLM_PROVIDER: 'not-a-provider',
        OPENAI_API_KEY: 'key',
        OPENAI_MODEL: 'x'
      })
    ).toThrow(/未知 AGENT_LLM_PROVIDER/);
  });
});
