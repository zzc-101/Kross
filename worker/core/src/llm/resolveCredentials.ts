import {
  getLlmProviderDefinition,
  type LlmProvider,
  type ResolvedProviderCredentials
} from './llmProviders';
import type { ThinkingEffort } from './thinkingEffort';

export interface ResolvedLlmCredentials extends ResolvedProviderCredentials {
  thinkingEffort?: ThinkingEffort;
  contextWindow?: number;
}

/**
 * Env-only credential resolve. Returns undefined when model or secret is
 * still missing. Never throws for incomplete config (callers decide whether
 * to error).
 */
export function resolveProviderCredentials(
  provider: LlmProvider,
  env: Record<string, string | undefined> = {},
  explicitModel?: string
): ResolvedLlmCredentials | undefined {
  const def = getLlmProviderDefinition(provider);

  const apiKey = firstEnv(env, def.apiKeyEnv);
  const authToken = def.authTokenEnv
    ? firstEnv(env, def.authTokenEnv)
    : undefined;
  const model = firstNonEmpty(explicitModel, firstEnv(env, def.modelEnv));
  const baseUrl = def.baseUrlEnv ? env[def.baseUrlEnv] : undefined;

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
      provider === 'anthropic' ? firstNonEmpty(env.ANTHROPIC_VERSION) : undefined,
    thinkingEffort: undefined,
    contextWindow: parsePositiveInt(
      env.AGENT_CONTEXT_WINDOW ?? env.KROSS_CONTEXT_WINDOW
    )
  };
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

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}
