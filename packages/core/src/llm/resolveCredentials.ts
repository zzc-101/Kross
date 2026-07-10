import type { ImportedLlmConfig } from '../config/configImport';
import {
  getLlmProviderDefinition,
  type LlmProvider,
  type ResolvedProviderCredentials
} from './llmProviders';
import type { ThinkingEffort } from './thinkingEffort';

export interface ResolvedLlmCredentials extends ResolvedProviderCredentials {
  thinkingEffort?: ThinkingEffort;
}

/**
 * Soft credential resolve: env wins per-field, then saved kross config for the
 * same provider. Returns undefined when model or secret is still missing.
 * Never throws for incomplete config (callers decide whether to error).
 */
export function resolveProviderCredentials(
  provider: LlmProvider,
  env: Record<string, string | undefined> = {},
  saved?: ImportedLlmConfig
): ResolvedLlmCredentials | undefined {
  const def = getLlmProviderDefinition(provider);
  const savedMatch = saved?.provider === provider ? saved : undefined;

  const apiKey = firstNonEmpty(
    firstEnv(env, def.apiKeyEnv),
    savedMatch?.apiKey
  );
  const authToken = firstNonEmpty(
    def.authTokenEnv ? firstEnv(env, def.authTokenEnv) : undefined,
    savedMatch?.authToken
  );
  const model = firstNonEmpty(
    firstEnv(env, def.modelEnv),
    savedMatch?.model
  );
  const baseUrl = firstNonEmpty(
    def.baseUrlEnv ? env[def.baseUrlEnv] : undefined,
    savedMatch?.baseUrl
  );

  if (!model || !(apiKey || authToken)) {
    return undefined;
  }

  return {
    provider,
    apiKey,
    authToken,
    model,
    baseUrl,
    anthropicVersion:
      provider === 'anthropic'
        ? firstNonEmpty(env.ANTHROPIC_VERSION, savedMatch?.anthropicVersion)
        : undefined,
    thinkingEffort: savedMatch?.thinkingEffort
  };
}

/** Whether a saved llm block can construct a client. */
export function isUsableLlmConfig(
  config: ImportedLlmConfig | undefined
): config is ImportedLlmConfig {
  if (!config?.model || !config.provider) {
    return false;
  }
  if (config.provider === 'anthropic') {
    return Boolean(config.apiKey || config.authToken);
  }
  return Boolean(config.apiKey);
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

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
