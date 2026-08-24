import { AnthropicProtocolClient } from './anthropicProtocolClient';
import {
  getLlmProviderDefinition,
  isLlmProvider,
  listProvidersFromEnv,
  type LlmProvider
} from './llmProviders';
import { OpenAiProtocolClient } from './openAiProtocolClient';
import { PiAiLlmClient } from './piAiLlmClient';
import { resolveProviderCredentials } from './resolveCredentials';
import {
  DEFAULT_THINKING_EFFORT,
  parseThinkingEffort,
  type ThinkingEffort
} from './thinkingEffort';
import type { LlmClient, LlmClientConfig, LlmFetch } from './types';

export type LlmBackend = 'pi' | 'native';

/**
 * Create an LlmClient.
 *
 * Default backend is `pi` (@earendil-works/pi-ai) for multi-provider maturity.
 * Falls back to native protocol clients when:
 * - `config.fetch` is injected (tests / custom transport), or
 * - `backend: 'native'`, or
 * - env `AGENT_LLM_BACKEND=native`.
 */
export function createLlmClient(
  config: LlmClientConfig & { backend?: LlmBackend }
): LlmClient {
  const backend = resolveBackend(config.backend, config.fetch, config.provider);

  if (backend === 'native') {
    if (config.provider === 'anthropic') {
      return new AnthropicProtocolClient({ ...config, provider: 'anthropic' });
    }
    return new OpenAiProtocolClient({
      ...config,
      provider: config.provider
    });
  }

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
    anthropicVersion?: string;
    thinkingEffort?: ThinkingEffort;
    contextWindow?: number;
  },
  env: Record<string, string | undefined>,
  fetch?: LlmFetch
): LlmClient {
  const backend = parseBackend(env.AGENT_LLM_BACKEND);
  const thinkingEffort =
    credentials.thinkingEffort ??
    parseThinkingEffort(env.AGENT_THINKING_EFFORT) ??
    parseThinkingEffort(env.KROSS_THINKING_EFFORT) ??
    DEFAULT_THINKING_EFFORT;

  if (credentials.provider === 'anthropic') {
    return createLlmClient({
      provider: 'anthropic',
      apiKey: credentials.apiKey,
      authToken: credentials.authToken,
      model: credentials.model,
      baseUrl: credentials.baseUrl,
      anthropicVersion: credentials.anthropicVersion,
      thinkingEffort,
      contextWindow: credentials.contextWindow,
      fetch,
      backend
    });
  }

  if (!credentials.apiKey) {
    throw new Error(`${credentials.provider} 需要 API key`);
  }

  return createLlmClient({
    provider: credentials.provider,
    apiKey: credentials.apiKey,
    model: credentials.model,
    baseUrl: credentials.baseUrl,
    thinkingEffort,
    contextWindow: credentials.contextWindow,
    fetch,
    backend
  });
}

function resolveBackend(
  explicit: LlmBackend | undefined,
  fetch: LlmFetch | undefined,
  provider: LlmProvider
): LlmBackend {
  if (explicit) {
    if (
      explicit === 'native' &&
      !getLlmProviderDefinition(provider).supportsNative
    ) {
      return 'pi';
    }
    return explicit;
  }
  if (fetch) {
    return 'native';
  }
  return 'pi';
}

function parseBackend(raw: string | undefined): LlmBackend | undefined {
  if (raw === 'pi' || raw === 'native') {
    return raw;
  }
  return undefined;
}

function listProviderIds(): string[] {
  return listProvidersFromEnv({}).map((row) => row.provider);
}
