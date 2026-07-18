import {
  type Api,
  type Model,
  type MutableModels,
  type SimpleStreamOptions
} from '@earendil-works/pi-ai';

import type { LlmProvider } from './llmProviders';
import {
  fromPiAssistantMessage,
  mapPiStreamEvent,
  toPiContext
} from './piAiConvert';
import {
  createPiAiModels,
  FALLBACK_MAX_TOKENS,
  normalizeAnthropicBaseUrl,
  normalizeOpenAiBaseUrl,
  resolvePiAiModel
} from './piAiModels';
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

/** 流式两次 chunk 之间最长空闲；超时当作取消，避免半开连接死等 + UI 空转 */
const STREAM_IDLE_MS = 180_000;

/**
 * LlmClient backed by @earendil-works/pi-ai.
 * Keeps Kross's LlmClient surface; maps messages/tools/stream events at the boundary.
 */
export class PiAiLlmClient implements LlmClient {
  readonly provider: LlmProvider;
  readonly publicModelId: string | undefined;
  private _model: string;
  private _thinkingEffort: ThinkingEffort;
  private _lastUsage: LlmUsage | undefined;

  private readonly models: MutableModels;
  private piModel: Model<Api>;
  private readonly apiKey?: string;
  private readonly authToken?: string;

  constructor(private readonly config: LlmClientConfig) {
    this.provider = config.provider;
    this.publicModelId = config.publicModelId;
    this._model = config.model;
    this._thinkingEffort = config.thinkingEffort ?? DEFAULT_THINKING_EFFORT;
    this.apiKey = config.apiKey;
    this.authToken =
      this.provider === 'anthropic' ? config.authToken : undefined;

    this.models = createPiAiModels(this.provider, {
      baseUrl: this.config.baseUrl,
      headerAuth: Boolean(this.authToken)
    });
    this.piModel = this.resolveModel(this._model);
  }

  get model(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort {
    return this._thinkingEffort;
  }

  get contextWindow(): number {
    return this.piModel.contextWindow;
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
    if (this.publicModelId && next !== this._model) {
      throw new Error('公益模型不支持修改底层 model id，请从 /model 面板切换模型');
    }
    this._model = next;
    this.piModel = this.resolveModel(next);
  }

  setThinkingEffort(effort: ThinkingEffort): void {
    this._thinkingEffort = effort;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    throwIfAborted(request.signal);
    const model = this.modelForRequest(request);
    const context = toPiContext(request.messages, request.tools, {
      provider: this.provider,
      model: model.id,
      api: model.api
    });

    // raceAbort：即使 pi-ai 未及时响应 signal，await 也能在 Esc 时立刻解开
    const message = await raceAbort(
      this.models.completeSimple(
        model,
        context,
        this.simpleStreamOptions(request, model)
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
    const model = this.modelForRequest(request);
    const context = toPiContext(request.messages, request.tools, {
      provider: this.provider,
      model: model.id,
      api: model.api
    });

    const stream = this.models.streamSimple(
      model,
      context,
      this.simpleStreamOptions(request, model)
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
    return this.resolveModel(modelId);
  }

  private resolveModel(modelId: string): Model<Api> {
    return resolvePiAiModel(this.models, this.provider, modelId, {
      baseUrl: this.config.baseUrl,
      contextWindow: this.config.contextWindow,
      wireApi: this.config.wireApi
    });
  }

  private simpleStreamOptions(
    request: LlmRequest,
    model: Model<Api>
  ): SimpleStreamOptions {
    const effort = request.thinkingEffort ?? this._thinkingEffort;
    const options: SimpleStreamOptions = {
      temperature: request.temperature,
      maxTokens: request.maxTokens ?? model.maxTokens ?? FALLBACK_MAX_TOKENS,
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

export { normalizeAnthropicBaseUrl, normalizeOpenAiBaseUrl };
