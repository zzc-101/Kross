import { AnthropicProtocolClient } from './anthropicProtocolClient';
import { OpenAiProtocolClient } from './openAiProtocolClient';
import type { LlmClient, LlmClientConfig, LlmFetch } from './types';

export function createLlmClient(config: LlmClientConfig): LlmClient {
  if (config.provider === 'anthropic') {
    return new AnthropicProtocolClient(config);
  }

  return new OpenAiProtocolClient(config);
}

export function createLlmClientFromEnv(
  env: Record<string, string | undefined>,
  fetch?: LlmFetch
): LlmClient | undefined {
  const provider = env.AGENT_LLM_PROVIDER;

  if (provider === 'openai') {
    const apiKey = env.OPENAI_API_KEY;
    const model = env.OPENAI_MODEL;
    if (!apiKey || !model) {
      throw new Error('OpenAI 协议需要配置 OPENAI_API_KEY 和 OPENAI_MODEL');
    }

    return createLlmClient({
      provider,
      apiKey,
      model,
      baseUrl: env.OPENAI_BASE_URL,
      fetch
    });
  }

  if (provider === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY;
    const model = env.ANTHROPIC_MODEL;
    if (!apiKey || !model) {
      throw new Error('Anthropic 协议需要配置 ANTHROPIC_API_KEY 和 ANTHROPIC_MODEL');
    }

    return createLlmClient({
      provider,
      apiKey,
      model,
      baseUrl: env.ANTHROPIC_BASE_URL,
      anthropicVersion: env.ANTHROPIC_VERSION,
      fetch
    });
  }

  return undefined;
}
