import { isLlmProvider, listProvidersFromEnv, type LlmProvider } from './llmProviders';
import { PiAiLlmClient } from './piAiLlmClient';
import { resolveProviderCredentials } from './resolveCredentials';
import {
  DEFAULT_THINKING_EFFORT,
  parseThinkingEffort,
  type ThinkingEffort
} from './thinkingEffort';
import type { LlmClient, LlmClientConfig, LlmFetch } from './types';

/**
 * Create an LlmClient backed by @earendil-works/pi-ai.
 */
export function createLlmClient(config: LlmClientConfig): LlmClient {
  return new PiAiLlmClient(config);
}

/**
 * Build client from env when AGENT_LLM_PROVIDER is fully configured.
 * Incomplete env (missing key/model) returns undefined so callers can decide
 * how to surface the misconfiguration — never throw on incomplete env.
 */
export function createLlmClientFromEnv(
  env: Record<string, string | undefined>,
  fetch?: LlmFetch,
  configuredContextWindow?: number
): LlmClient | undefined {
  const providerRaw = env.AGENT_LLM_PROVIDER?.trim();
  if (!providerRaw) {
    return undefined;
  }

  if (!isLlmProvider(providerRaw)) {
    throw new Error(
      `未知 AGENT_LLM_PROVIDER=${providerRaw}。可选：${listProviderIds().join(', ')}`
    );
  }

  const credentials = resolveProviderCredentials(providerRaw, env);
  if (!credentials) {
    return undefined;
  }

  return createLlmClientFromCredentials(
    {
      ...credentials,
      contextWindow: credentials.contextWindow ?? configuredContextWindow
    },
    env,
    fetch
  );
}

function createLlmClientFromCredentials(
  credentials: {
    provider: LlmProvider;
    apiKey?: string;
    authToken?: string;
    model: string;
    baseUrl?: string;
    thinkingEffort?: ThinkingEffort;
    contextWindow?: number;
  },
  env: Record<string, string | undefined>,
  fetch?: LlmFetch
): LlmClient {
  const thinkingEffort =
    credentials.thinkingEffort ??
    parseThinkingEffort(env.AGENT_THINKING_EFFORT) ??
    parseThinkingEffort(env.APP_THINKING_EFFORT) ??
    DEFAULT_THINKING_EFFORT;

  if (credentials.provider !== 'anthropic' && !credentials.apiKey) {
    throw new Error(`${credentials.provider} 需要 API key`);
  }

  return createLlmClient({
    provider: credentials.provider,
    apiKey: credentials.apiKey,
    authToken: credentials.authToken,
    model: credentials.model,
    baseUrl: credentials.baseUrl,
    thinkingEffort,
    contextWindow: credentials.contextWindow,
    fetch
  });
}

function listProviderIds(): string[] {
  return listProvidersFromEnv({}).map((row) => row.provider);
}
