import { isOperationAborted } from '../abort';
import type { LlmCapabilities } from './providerCapabilities';
import type { ThinkingEffort } from './thinkingEffort';
import {
  LlmProviderError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmUsage
} from './types';
import type { LlmProvider } from './llmProviders';

export const LLM_CALL_METRICS_VERSION = 1;

export type LlmErrorCategory =
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'invalid-request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'unknown';

export interface LlmCallMetrics {
  version: typeof LLM_CALL_METRICS_VERSION;
  provider: LlmProvider;
  model: string;
  status: 'completed' | 'failed' | 'aborted';
  durationMs: number;
  rateLimited: boolean;
  usage?: LlmUsage;
  errorCategory?: LlmErrorCategory;
}

/** Adds bounded, content-free per-call metrics around any LlmClient. */
export function withLlmObservability(
  client: LlmClient,
  now: () => number = () => performance.now()
): LlmClient {
  if (client instanceof ObservableLlmClient) return client;
  return new ObservableLlmClient(client, now);
}

export function classifyLlmError(error: unknown): LlmErrorCategory {
  if (isOperationAborted(error)) return 'aborted';
  if (error instanceof LlmProviderError) {
    if (error.status === 401) return 'authentication';
    if (error.status === 403) return 'permission';
    if (error.status === 429) return 'rate-limit';
    if (error.status !== undefined && error.status >= 400 && error.status < 500) {
      return 'invalid-request';
    }
    if (error.status !== undefined && error.status >= 500) return 'server';
  }
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || /\\btimeout\\b|timed out/i.test(error.message))
  ) {
    return 'timeout';
  }
  if (error instanceof TypeError) return 'network';
  return 'unknown';
}

export class LlmCallMetricsRecorder {
  private _last: LlmCallMetrics | undefined;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get last(): LlmCallMetrics | undefined {
    return this._last;
  }

  start(): number {
    return this.now();
  }

  complete(
    provider: LlmProvider,
    model: string,
    started: number,
    usage?: LlmUsage
  ): void {
    this._last = {
      version: LLM_CALL_METRICS_VERSION,
      provider,
      model,
      status: 'completed',
      durationMs: elapsed(started, this.now()),
      rateLimited: false,
      ...(usage ? { usage: structuredClone(usage) } : {})
    };
  }

  fail(
    provider: LlmProvider,
    model: string,
    started: number,
    error: unknown
  ): void {
    const category = classifyLlmError(error);
    this._last = {
      version: LLM_CALL_METRICS_VERSION,
      provider,
      model,
      status: category === 'aborted' ? 'aborted' : 'failed',
      durationMs: elapsed(started, this.now()),
      rateLimited: category === 'rate-limit',
      errorCategory: category
    };
  }

  clear(): void {
    this._last = undefined;
  }
}

class ObservableLlmClient implements LlmClient {
  private _lastCallMetrics: LlmCallMetrics | undefined;

  constructor(
    private readonly inner: LlmClient,
    private readonly now: () => number
  ) {}

  get provider(): LlmProvider {
    return this.inner.provider;
  }

  get publicModelId(): string | undefined {
    return this.inner.publicModelId;
  }

  get model(): string | undefined {
    return this.inner.model;
  }

  get thinkingEffort(): ThinkingEffort | undefined {
    return this.inner.thinkingEffort;
  }

  get contextWindow(): number | undefined {
    return this.inner.contextWindow;
  }

  get capabilities(): LlmCapabilities | undefined {
    return this.inner.capabilities;
  }

  get lastUsage(): LlmUsage | undefined {
    return this.inner.lastUsage;
  }

  get lastCallMetrics(): LlmCallMetrics | undefined {
    return this._lastCallMetrics;
  }

  setModel(model: string): void {
    if (!this.inner.setModel) throw new Error('当前 LLM 客户端不支持切换模型');
    this.inner.setModel(model);
  }

  setThinkingEffort(effort: ThinkingEffort): void {
    if (!this.inner.setThinkingEffort) {
      throw new Error('当前 LLM 客户端不支持切换思考强度');
    }
    this.inner.setThinkingEffort(effort);
  }

  clearLastUsage(): void {
    this.inner.clearLastUsage?.();
    this._lastCallMetrics = undefined;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const started = this.now();
    try {
      const response = await this.inner.complete(request);
      this._lastCallMetrics = this.completed(started, response.usage);
      return response;
    } catch (error) {
      this._lastCallMetrics = this.failed(started, error);
      throw error;
    }
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const started = this.now();
    let usage: LlmUsage | undefined;
    let completed = false;
    try {
      for await (const chunk of this.inner.stream(request)) {
        if (chunk.type === 'done') {
          usage = chunk.usage;
          completed = true;
        }
        yield chunk;
      }
      this._lastCallMetrics = completed
        ? this.completed(started, usage ?? this.inner.lastUsage)
        : this.failed(started, new DOMException('stream closed', 'AbortError'));
    } catch (error) {
      this._lastCallMetrics = this.failed(started, error);
      throw error;
    } finally {
      if (!this._lastCallMetrics) {
        this._lastCallMetrics = this.failed(
          started,
          new DOMException('stream cancelled', 'AbortError')
        );
      }
    }
  }

  private completed(started: number, usage?: LlmUsage): LlmCallMetrics {
    return {
      version: LLM_CALL_METRICS_VERSION,
      provider: this.provider,
      model: this.model ?? 'unknown',
      status: 'completed',
      durationMs: elapsed(started, this.now()),
      rateLimited: false,
      ...(usage ? { usage: structuredClone(usage) } : {})
    };
  }

  private failed(started: number, error: unknown): LlmCallMetrics {
    const category = classifyLlmError(error);
    return {
      version: LLM_CALL_METRICS_VERSION,
      provider: this.provider,
      model: this.model ?? 'unknown',
      status: category === 'aborted' ? 'aborted' : 'failed',
      durationMs: elapsed(started, this.now()),
      rateLimited: category === 'rate-limit',
      errorCategory: category
    };
  }
}

function elapsed(started: number, ended: number): number {
  return Math.max(0, Math.round(ended - started));
}
