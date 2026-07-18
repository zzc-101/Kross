import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type MutableModels,
  type Provider
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';

import {
  getLlmProviderDefinition,
  type LlmProvider
} from './llmProviders';
import { resolveModelContextWindow } from './modelContextWindows';
import type { OpenAiWireApi } from './types';

export const FALLBACK_MAX_TOKENS = 32_768;

const PROVIDER_FACTORIES: Record<LlmProvider, () => Provider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  openrouter: openrouterProvider,
  deepseek: deepseekProvider,
  xai: xaiProvider
};

export interface CreatePiAiModelsOptions {
  baseUrl?: string;
  /** Kross supplies Authorization directly; do not also resolve ambient keys. */
  headerAuth?: boolean;
}

/**
 * Build a small pi-ai registry containing only the active provider.
 *
 * Provider factories own the wire protocol implementation and model catalog;
 * Kross only adapts its runtime types at the PiAiLlmClient boundary.
 */
export function createPiAiModels(
  provider: LlmProvider,
  options: CreatePiAiModelsOptions = {}
): MutableModels {
  const models = createModels();
  const created = PROVIDER_FACTORIES[provider]();
  const builtin: Provider = options.headerAuth
    ? {
        ...created,
        auth: {
          apiKey: {
            name: 'Kross explicit Authorization header',
            resolve: async () => undefined
          }
        }
      }
    : created;
  if (provider === 'openai' && isCustomOpenAiBaseUrl(options.baseUrl)) {
    models.setProvider(
      createProvider({
        id: builtin.id,
        name: builtin.name,
        baseUrl: builtin.baseUrl,
        headers: builtin.headers,
        auth: builtin.auth,
        models: builtin.getModels(),
        api: {
          'openai-responses': openAIResponsesApi(),
          'openai-completions': openAICompletionsApi()
        }
      })
    );
  } else {
    models.setProvider(builtin);
  }
  return models;
}

export interface ResolvePiAiModelOptions {
  baseUrl?: string;
  contextWindow?: number;
  env?: Record<string, string | undefined>;
  wireApi?: OpenAiWireApi;
}

/**
 * Resolve a catalog model when available. Unknown/private model ids still run
 * through the same pi-ai provider protocol using a conservative descriptor.
 */
export function resolvePiAiModel(
  models: MutableModels,
  provider: LlmProvider,
  modelId: string,
  options: ResolvePiAiModelOptions = {}
): Model<Api> {
  const id = modelId.trim();
  if (!id) {
    throw new Error('model 不能为空');
  }

  const catalogModel = models.getModel(provider, id);
  const template = catalogModel ?? models.getModels(provider)[0];
  if (!template) {
    throw new Error(`pi-ai provider ${provider} 没有可用的模型协议模板`);
  }

  const contextWindow = resolveModelContextWindow(
    id,
    options.env ?? process.env,
    options.contextWindow,
    catalogModel?.contextWindow
  );
  const baseUrl = normalizePiModelBaseUrl(
    template.api,
    options.baseUrl ?? template.baseUrl
  );
  const openAiApi = resolveOpenAiApi(
    provider,
    options.baseUrl,
    options.wireApi
  );

  if (catalogModel) {
    return {
      ...catalogModel,
      ...(openAiApi
        ? {
            api: openAiApi,
            ...(openAiApi === 'openai-completions'
              ? { compat: undefined }
              : {})
          }
        : {}),
      baseUrl,
      contextWindow
    };
  }

  return {
    ...template,
    id,
    name: id,
    ...(openAiApi
      ? {
          api: openAiApi,
          ...(openAiApi === 'openai-completions'
            ? { compat: undefined }
            : {})
        }
      : {}),
    baseUrl,
    reasoning: true,
    thinkingLevelMap: undefined,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: FALLBACK_MAX_TOKENS
  };
}

function resolveOpenAiApi(
  provider: LlmProvider,
  baseUrl: string | undefined,
  wireApi: OpenAiWireApi | undefined
): 'openai-responses' | 'openai-completions' | undefined {
  if (provider !== 'openai') {
    return undefined;
  }
  if (wireApi === 'responses') {
    return 'openai-responses';
  }
  if (wireApi === 'completions' || isCustomOpenAiBaseUrl(baseUrl)) {
    return 'openai-completions';
  }
  return undefined;
}

export function listPiAiBuiltinModels(provider: LlmProvider): readonly Model<Api>[] {
  return PROVIDER_FACTORIES[provider]().getModels();
}

export function normalizePiModelBaseUrl(api: Api, baseUrl?: string): string {
  if (api === 'anthropic-messages') {
    return normalizeAnthropicBaseUrl(baseUrl);
  }
  return normalizeOpenAiBaseUrl(baseUrl);
}

function isCustomOpenAiBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) {
    return false;
  }
  return (
    normalizeOpenAiBaseUrl(baseUrl) !==
    normalizeOpenAiBaseUrl(
      getLlmProviderDefinition('openai').defaultBaseUrl
    )
  );
}

/** OpenAI-family SDKs expect a versioned API root. */
export function normalizeOpenAiBaseUrl(baseUrl?: string): string {
  const fallback = getLlmProviderDefinition('openai').defaultBaseUrl;
  const raw = (baseUrl ?? fallback).replace(/\/+$/, '');
  return raw || fallback;
}

/**
 * Anthropic SDK appends /v1/messages itself. Strip a trailing /v1 so imported
 * Kross and Claude-compatible gateway configs keep working.
 */
export function normalizeAnthropicBaseUrl(baseUrl?: string): string {
  const fallback = getLlmProviderDefinition('anthropic').defaultBaseUrl;
  const raw = (baseUrl ?? fallback).replace(/\/+$/, '');
  if (!raw) {
    return fallback;
  }
  return raw.replace(/\/v1$/i, '') || fallback;
}
