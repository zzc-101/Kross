import { AnthropicProtocolClient } from './anthropicProtocolClient';
import {
  getLlmProviderDefinition,
  isLlmProvider,
  listProvidersFromEnv,
  resolveProviderCredentialsFromEnv,
  type LlmProvider
} from './llmProviders';
import { OpenAiProtocolClient } from './openAiProtocolClient';
import { PiAiLlmClient } from './piAiLlmClient';
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

export function createLlmClientFromEnv(
  env: Record<string, string | undefined>,
  fetch?: LlmFetch
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

  const credentials = resolveProviderCredentialsFromEnv(providerRaw, env);
  if (!credentials) {
    // Provider name set but empty — resolveProviderCredentialsFromEnv throws if partial.
    // If completely empty it returns undefined; still require full config when provider is set.
    const def = getLlmProviderDefinition(providerRaw);
    throw new Error(
      `${def.name} 未配置完整。需要密钥（${[...def.apiKeyEnv, ...(def.authTokenEnv ?? [])].join('/')}）和模型（${def.modelEnv.join('/')}）`
    );
  }

  return createLlmClientFromCredentials(credentials, env, fetch);
}

/** Create a client for an explicit provider+model using env credentials. */
export function createLlmClientForProvider(
  provider: LlmProvider,
  model: string,
  env: Record<string, string | undefined>,
  fetch?: LlmFetch
): LlmClient {
  const credentials = resolveProviderCredentialsFromEnv(provider, env);
  if (!credentials) {
    const def = getLlmProviderDefinition(provider);
    throw new Error(
      `${def.name} 未配置密钥。请设置 ${[...def.apiKeyEnv, ...(def.authTokenEnv ?? [])].join(' 或 ')}`
    );
  }

  return createLlmClientFromCredentials(
    { ...credentials, model: model.trim() || credentials.model },
    env,
    fetch
  );
}

export function formatProvidersStatus(
  env: Record<string, string | undefined>,
  current?: { provider: LlmProvider; model?: string }
): string {
  const rows = listProvidersFromEnv(env);
  const lines = [
    'Providers',
    ...rows.map((row) => {
      const mark = row.configured ? '✓' : '·';
      const currentMark =
        current?.provider === row.provider ? ' (current)' : '';
      const modelPart = row.model
        ? ` model=${row.model}`
        : ` example=${row.exampleModel}`;
      return `${mark} ${row.provider}${currentMark}${modelPart}`;
    }),
    '',
    '用法：',
    '  /model                     查看当前模型',
    '  /model list                列出 provider',
    '  /model <modelId>           切换当前 provider 的模型',
    '  /model <provider> <model>  切换 provider + 模型（需对应 env 密钥）'
  ];
  return lines.join('\n');
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
  // Injectable fetch is only supported by the native HTTP clients.
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
