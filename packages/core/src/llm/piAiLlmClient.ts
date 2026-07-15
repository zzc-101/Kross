import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type MutableModels,
  type SimpleStreamOptions
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

import {
  getLlmProviderDefinition,
  type LlmProvider
} from './llmProviders';
import { resolveModelContextWindow } from './modelContextWindows';
import {
  fromPiAssistantMessage,
  mapPiStreamEvent,
  toPiContext
} from './piAiConvert';
import {
  abortReason,
  abortableAsyncIterable,
  isOperationAborted,
  raceAbort,
  throwIfAborted
} from '../abort';
import {
  DEFAULT_THINKING_EFFORT,
  type ThinkingEffort
} from './thinkingEffort';
import type {
  LlmClient,
  LlmClientConfig,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
  LlmUsage
} from './types';
import { LlmProviderError } from './types';

const DEFAULT_MAX_TOKENS = 32_768;
/** 流式两次 chunk 之间最长空闲；超时当作取消，避免半开连接死等 + UI 空转 */
const STREAM_IDLE_MS = 180_000;

/**
 * LlmClient backed by @earendil-works/pi-ai.
 * Keeps Kross's LlmClient surface; maps messages/tools/stream events at the boundary.
 */
export class PiAiLlmClient implements LlmClient {
  readonly provider: LlmProvider;
  private _model: string;
  private _thinkingEffort: ThinkingEffort;
  private _lastUsage: LlmUsage | undefined;

  private readonly models: MutableModels;
  private piModel: Model<Api>;
  private readonly apiKey?: string;
  private readonly authToken?: string;
  private readonly api: string;

  constructor(private readonly config: LlmClientConfig) {
    this.provider = config.provider;
    this._model = config.model;
    this._thinkingEffort = config.thinkingEffort ?? DEFAULT_THINKING_EFFORT;
    this.apiKey = config.apiKey;
    this.authToken =
      this.provider === 'anthropic' ? config.authToken : undefined;

    const def = getLlmProviderDefinition(this.provider);
    this.api = def.apiFamily;
    this.piModel = buildModel(config);
    this.models = createModels();
    this.models.setProvider(buildProvider(config, this.piModel, this.apiKey, this.authToken));
  }

  get model(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort {
    return this._thinkingEffort;
  }

  get contextWindow(): number {
    return resolveModelContextWindow(
      this._model,
      process.env,
      this.config.contextWindow
    );
  }

  get lastUsage(): LlmUsage | undefined {
    return this._lastUsage;
  }

  clearLastUsage(): void {
    this._lastUsage = undefined;
  }

  setModel(model: string): void {
    const next = model.trim();
    if (!next) {
      throw new Error('model 不能为空');
    }
    this._model = next;
    this.piModel = {
      ...this.piModel,
      id: next,
      name: next,
      contextWindow: this.contextWindow
    };
  }

  setThinkingEffort(effort: ThinkingEffort): void {
    this._thinkingEffort = effort;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    throwIfAborted(request.signal);
    const context = toPiContext(request.messages, request.tools, {
      provider: this.provider,
      model: request.model ?? this._model,
      api: this.api
    });

    // raceAbort：即使 pi-ai 未及时响应 signal，await 也能在 Esc 时立刻解开
    const message = await raceAbort(
      this.models.completeSimple(
        this.modelForRequest(request),
        context,
        this.simpleStreamOptions(request)
      ),
      request.signal
    );

    if (message.stopReason === 'aborted' || request.signal?.aborted) {
      throw abortReason(request.signal, message.errorMessage ?? 'request aborted');
    }
    if (message.stopReason === 'error') {
      throw new LlmProviderError(
        message.errorMessage ?? 'request error',
        this.provider
      );
    }

    const response = fromPiAssistantMessage(message, this.provider);
    this._lastUsage = response.usage;
    return response;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    throwIfAborted(request.signal);
    this._lastUsage = undefined;
    const context = toPiContext(request.messages, request.tools, {
      provider: this.provider,
      model: request.model ?? this._model,
      api: this.api
    });

    const stream = this.models.streamSimple(
      this.modelForRequest(request),
      context,
      this.simpleStreamOptions(request)
    );

    try {
      // 每步 next() 与 signal 竞态：否则 provider 半开连接时 for-await 永不返回，
      // Esc 无效，而 TUI spinner 仍 80ms 全屏重绘把事件循环打满。
      for await (const event of abortableAsyncIterable(stream, request.signal, {
        idleMs: STREAM_IDLE_MS,
        idleMessage: `LLM stream idle for ${STREAM_IDLE_MS}ms`
      })) {
        throwIfAborted(request.signal);
        const mapped = mapPiStreamEvent(event);
        if (!mapped) {
          continue;
        }
        if (mapped.type === 'error') {
          if (
            request.signal?.aborted ||
            /abort/i.test(mapped.message)
          ) {
            throw abortReason(request.signal, mapped.message);
          }
          throw new LlmProviderError(mapped.message, this.provider);
        }
        if (mapped.type === 'done') {
          this._lastUsage = mapped.usage;
        }
        yield mapped;
      }
    } catch (error) {
      if (isOperationAborted(error, request.signal)) {
        throw error instanceof Error ? error : abortReason(request.signal);
      }
      throw error;
    }
  }

  private modelForRequest(request: LlmRequest): Model<Api> {
    const modelId = request.model ?? this._model;
    if (modelId === this.piModel.id) {
      return this.piModel;
    }
    return {
      ...this.piModel,
      id: modelId,
      name: modelId,
      contextWindow: resolveModelContextWindow(
        modelId,
        process.env,
        this.config.contextWindow
      )
    };
  }

  private simpleStreamOptions(request: LlmRequest): SimpleStreamOptions {
    const effort = request.thinkingEffort ?? this._thinkingEffort;
    const options: SimpleStreamOptions = {
      temperature: request.temperature,
      maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      metadata: request.metadata,
      signal: request.signal
    };

    // pi streamSimple: omit reasoning => thinking off; otherwise map effort.
    if (effort !== 'off') {
      options.reasoning = effort;
    }

    if (this.authToken) {
      options.headers = {
        authorization: `Bearer ${this.authToken}`
      };
    } else if (this.apiKey) {
      options.apiKey = this.apiKey;
    }

    return options;
  }
}

function buildProvider(
  config: LlmClientConfig,
  model: Model<Api>,
  apiKey: string | undefined,
  authToken: string | undefined
) {
  const def = getLlmProviderDefinition(config.provider);

  if (def.apiFamily === 'anthropic-messages') {
    return createProvider({
      id: model.provider,
      name: def.name,
      baseUrl: model.baseUrl,
      auth: {
        apiKey: {
          name: 'API key',
          resolve: async () => {
            if (authToken) {
              return {
                auth: {
                  headers: {
                    authorization: `Bearer ${authToken}`
                  }
                }
              };
            }
            if (apiKey) {
              return { auth: { apiKey } };
            }
            return undefined;
          }
        }
      },
      models: [model as Model<'anthropic-messages'>],
      api: anthropicMessagesApi()
    });
  }

  return createProvider({
    id: model.provider,
    name: def.name,
    baseUrl: model.baseUrl,
    auth: {
      apiKey: {
        name: 'API key',
        resolve: async () => (apiKey ? { auth: { apiKey } } : undefined)
      }
    },
    models: [model as Model<'openai-completions'>],
    api: openAICompletionsApi()
  });
}

function buildModel(config: LlmClientConfig): Model<Api> {
  const def = getLlmProviderDefinition(config.provider);

  if (def.apiFamily === 'anthropic-messages') {
    return {
      id: config.model,
      name: config.model,
      api: 'anthropic-messages',
      provider: config.provider,
      baseUrl: normalizeAnthropicBaseUrl(config.baseUrl ?? def.defaultBaseUrl),
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: resolveModelContextWindow(
        config.model,
        process.env,
        config.contextWindow
      ),
      maxTokens: DEFAULT_MAX_TOKENS,
      compat: {
        supportsEagerToolInputStreaming: false,
        supportsLongCacheRetention: false
      }
    } satisfies Model<'anthropic-messages'>;
  }

  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: config.provider,
    baseUrl: normalizeOpenAiBaseUrl(config.baseUrl ?? def.defaultBaseUrl),
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: resolveModelContextWindow(
      config.model,
      process.env,
      config.contextWindow
    ),
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: openaiFamilyCompat(config.provider)
  } satisfies Model<'openai-completions'>;
}

function openaiFamilyCompat(
  provider: LlmProvider
): Model<'openai-completions'>['compat'] {
  if (provider === 'deepseek') {
    return {
      supportsStore: false,
      supportsDeveloperRole: false,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek'
    };
  }
  if (provider === 'openrouter') {
    return {
      thinkingFormat: 'openrouter'
    };
  }
  if (provider === 'xai') {
    return {
      supportsStore: false
    };
  }
  return undefined;
}

/** OpenAI-compatible chat completions expect .../v1. */
export function normalizeOpenAiBaseUrl(baseUrl?: string): string {
  const fallback = getLlmProviderDefinition('openai').defaultBaseUrl;
  const raw = (baseUrl ?? fallback).replace(/\/+$/, '');
  return raw || fallback;
}

/**
 * Anthropic SDK treats baseURL as origin root and appends /v1/messages.
 * Strip a trailing /v1 so imported Kross configs (with /v1) still work.
 */
export function normalizeAnthropicBaseUrl(baseUrl?: string): string {
  const fallback = getLlmProviderDefinition('anthropic').defaultBaseUrl;
  const raw = (baseUrl ?? fallback).replace(/\/+$/, '');
  if (!raw) {
    return fallback;
  }
  return raw.replace(/\/v1$/i, '') || fallback;
}
