import { z } from 'zod';

/** First-wave providers wired through pi-ai (and openai-family native fallback). */
export const llmProviderSchema = z.enum([
  'openai',
  'anthropic',
  'openrouter',
  'deepseek',
  'xai'
]);

export type LlmProvider = z.infer<typeof llmProviderSchema>;

export type LlmApiFamily = 'openai-completions' | 'anthropic-messages';

export interface LlmProviderDefinition {
  id: LlmProvider;
  name: string;
  apiFamily: LlmApiFamily;
  defaultBaseUrl: string;
  /** Env vars checked in order for API key. */
  apiKeyEnv: readonly string[];
  /** Env vars checked in order for default model. */
  modelEnv: readonly string[];
  /** Optional Bearer auth (Anthropic-compatible gateways). */
  authTokenEnv?: readonly string[];
  baseUrlEnv?: string;
  /** Shown in /model list help. */
  exampleModel: string;
  /** Native HTTP clients only implement openai + anthropic wire formats. */
  supportsNative: boolean;
}

export const LLM_PROVIDER_DEFINITIONS: Record<
  LlmProvider,
  LlmProviderDefinition
> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    apiFamily: 'openai-completions',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: ['OPENAI_API_KEY'],
    modelEnv: ['OPENAI_MODEL', 'AGENT_LLM_MODEL'],
    baseUrlEnv: 'OPENAI_BASE_URL',
    exampleModel: 'gpt-4o-mini',
    supportsNative: true
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    apiFamily: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    apiKeyEnv: ['ANTHROPIC_API_KEY'],
    authTokenEnv: ['ANTHROPIC_AUTH_TOKEN'],
    modelEnv: ['ANTHROPIC_MODEL', 'AGENT_LLM_MODEL'],
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    exampleModel: 'claude-sonnet-4-5',
    supportsNative: true
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    apiFamily: 'openai-completions',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: ['OPENROUTER_API_KEY'],
    modelEnv: ['OPENROUTER_MODEL', 'AGENT_LLM_MODEL'],
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    exampleModel: 'anthropic/claude-sonnet-4',
    supportsNative: true
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    apiFamily: 'openai-completions',
    defaultBaseUrl: 'https://api.deepseek.com',
    apiKeyEnv: ['DEEPSEEK_API_KEY'],
    modelEnv: ['DEEPSEEK_MODEL', 'AGENT_LLM_MODEL'],
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    exampleModel: 'deepseek-chat',
    supportsNative: true
  },
  xai: {
    id: 'xai',
    name: 'xAI',
    apiFamily: 'openai-completions',
    defaultBaseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: ['XAI_API_KEY'],
    modelEnv: ['XAI_MODEL', 'AGENT_LLM_MODEL'],
    baseUrlEnv: 'XAI_BASE_URL',
    exampleModel: 'grok-3-mini',
    supportsNative: true
  }
};

export const LLM_PROVIDERS = Object.values(LLM_PROVIDER_DEFINITIONS);

export function isLlmProvider(value: string): value is LlmProvider {
  return value in LLM_PROVIDER_DEFINITIONS;
}

export function getLlmProviderDefinition(
  provider: LlmProvider
): LlmProviderDefinition {
  return LLM_PROVIDER_DEFINITIONS[provider];
}

export function isOpenAiFamilyProvider(provider: LlmProvider): boolean {
  return getLlmProviderDefinition(provider).apiFamily === 'openai-completions';
}

export function isAnthropicFamilyProvider(provider: LlmProvider): boolean {
  return getLlmProviderDefinition(provider).apiFamily === 'anthropic-messages';
}

export function formatProviderModelLabel(
  provider: LlmProvider | undefined,
  model: string | undefined
): string {
  const modelName = model?.trim();
  if (!modelName) {
    return 'no model';
  }
  if (!provider) {
    return modelName;
  }
  return `${provider}/${modelName}`;
}

export interface ResolvedProviderCredentials {
  provider: LlmProvider;
  apiKey?: string;
  authToken?: string;
  model: string;
  baseUrl?: string;
  anthropicVersion?: string;
}

/**
 * Resolve credentials for a provider from env.
 * Returns undefined when the provider is not configured.
 * Throws when provider is set but incomplete (missing key/model).
 */
export function resolveProviderCredentialsFromEnv(
  provider: LlmProvider,
  env: Record<string, string | undefined>
): ResolvedProviderCredentials | undefined {
  const def = getLlmProviderDefinition(provider);
  const apiKey = firstEnv(env, def.apiKeyEnv);
  const authToken = def.authTokenEnv
    ? firstEnv(env, def.authTokenEnv)
    : undefined;
  const model = firstEnv(env, def.modelEnv);
  const baseUrl = def.baseUrlEnv ? env[def.baseUrlEnv] : undefined;
  const hasCredential = Boolean(apiKey || authToken);

  if (!hasCredential && !model) {
    return undefined;
  }

  if (!model) {
    throw new Error(
      `${def.name} 需要配置模型：${def.modelEnv.join(' 或 ')}（示例 ${def.exampleModel}）`
    );
  }

  if (!hasCredential) {
    const keyHint = [...def.apiKeyEnv, ...(def.authTokenEnv ?? [])].join(' 或 ');
    throw new Error(`${def.name} 需要配置密钥：${keyHint}`);
  }

  return {
    provider,
    apiKey,
    authToken,
    model,
    baseUrl,
    anthropicVersion:
      provider === 'anthropic' ? env.ANTHROPIC_VERSION : undefined
  };
}

export function listProvidersFromEnv(
  env: Record<string, string | undefined>
): Array<{
  provider: LlmProvider;
  name: string;
  configured: boolean;
  model?: string;
  exampleModel: string;
}> {
  return LLM_PROVIDERS.map((def) => {
    const apiKey = firstEnv(env, def.apiKeyEnv);
    const authToken = def.authTokenEnv
      ? firstEnv(env, def.authTokenEnv)
      : undefined;
    const model = firstEnv(env, def.modelEnv);
    const configured = Boolean((apiKey || authToken) && model);
    return {
      provider: def.id,
      name: def.name,
      configured,
      model: model || undefined,
      exampleModel: def.exampleModel
    };
  });
}

function firstEnv(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}
