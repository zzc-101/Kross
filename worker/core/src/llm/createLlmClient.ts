import type { ImportedLlmConfig } from '../config/configImport';
import { AnthropicProtocolClient } from './anthropicProtocolClient';
import {
  getLlmProviderDefinition,
  isLlmProvider,
  listProvidersFromEnv,
  type LlmProvider
} from './llmProviders';
import { OpenAiProtocolClient } from './openAiProtocolClient';
import { PiAiLlmClient } from './piAiLlmClient';
import { getPublicModel } from './publicModels';
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
 * Incomplete env (missing key/model) returns undefined so callers can fall
 * back to ~/.kross/config.json — never throw on incomplete env at startup.
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

/**
 * Create a client for an explicit provider+model.
 * Credentials: env first, then optional saved kross llm block for same provider.
 */
export function createLlmClientForProvider(
  provider: LlmProvider,
  model: string,
  env: Record<string, string | undefined>,
  fetch?: LlmFetch,
  saved?: ImportedLlmConfig
): LlmClient {
  const credentials = resolveProviderCredentials(provider, env, saved, model);
  if (!credentials) {
    const def = getLlmProviderDefinition(provider);
    throw new Error(
      `${def.name} 未配置密钥。请设置 ${[...def.apiKeyEnv, ...(def.authTokenEnv ?? [])].join(' 或 ')}，或先 /import 导入配置`
    );
  }

  return createLlmClientFromCredentials(
    {
      ...credentials,
      model: model.trim() || credentials.model,
      contextWindow: credentials.contextWindow ?? saved?.contextWindow
    },
    env,
    fetch
  );
}

export function createLlmClientForPublicModel(
  publicModelId: string,
  options: { thinkingEffort?: ThinkingEffort } = {}
): LlmClient {
  const definition = getPublicModel(publicModelId);
  if (!definition) {
    throw new Error(`未知公益模型：${publicModelId}`);
  }

  const common = {
    model: definition.model,
    baseUrl: definition.baseUrl,
    contextWindow: definition.contextWindow,
    thinkingEffort: options.thinkingEffort ?? DEFAULT_THINKING_EFFORT,
    publicModelId: definition.id,
    wireApi: definition.wireApi,
    backend: 'pi' as const
  };

  if (definition.provider === 'anthropic') {
    return createLlmClient({
      ...common,
      provider: 'anthropic',
      apiKey: definition.apiKey,
      authToken: definition.authToken
    });
  }
  if (!definition.apiKey) {
    throw new Error(`公益模型 ${definition.id} 缺少 API key`);
  }
  return createLlmClient({
    ...common,
    provider: definition.provider,
    apiKey: definition.apiKey
  });
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
