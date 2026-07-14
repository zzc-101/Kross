import { ensureOk, defaultFetch, joinUrl } from './http';
import { parseSse } from './sse';
import {
  DEFAULT_THINKING_EFFORT,
  type ThinkingEffort
} from './thinkingEffort';
import type {
  LlmClient,
  LlmFetch,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
  LlmToolCall,
  LlmToolDefinition,
  OpenAiFamilyClientConfig
} from './types';
import type { LlmUsage } from './types';
import { resolveModelContextWindow } from './modelContextWindows';

interface OpenAiChatResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      /** DeepSeek R1 / 多数 OpenAI-compat 推理模型 */
      reasoning_content?: string | null;
      /** 部分网关别名 */
      reasoning?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAiStreamResponse {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface StreamingToolCallAccumulator {
  id?: string;
  name?: string;
  argumentsText: string;
}

export class OpenAiProtocolClient implements LlmClient {
  readonly provider: 'openai' | 'openrouter' | 'deepseek' | 'xai';
  private _model: string;
  private _thinkingEffort: ThinkingEffort;
  private _lastUsage: LlmUsage | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: LlmFetch;

  constructor(private readonly config: OpenAiFamilyClientConfig) {
    this.provider = config.provider ?? 'openai';
    this._model = config.model;
    this._thinkingEffort = config.thinkingEffort ?? DEFAULT_THINKING_EFFORT;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.fetchImpl = config.fetch ?? defaultFetch();
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

  setModel(model: string): void {
    const next = model.trim();
    if (!next) {
      throw new Error('model 不能为空');
    }
    this._model = next;
  }

  setThinkingEffort(effort: ThinkingEffort): void {
    this._thinkingEffort = effort;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.fetchImpl(this.url(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(request, false))
    });

    await ensureOk(this.provider, response);
    const raw = (await response.json()) as OpenAiChatResponse;
    const message = raw.choices?.[0]?.message;
    const thinking = extractOpenAiThinking(message);

    const result: LlmResponse = {
      provider: this.provider,
      model: raw.model ?? request.model ?? this._model,
      text: message?.content ?? '',
      thinking: thinking || undefined,
      raw,
      toolCalls: parseToolCalls(raw),
      usage: {
        inputTokens: raw.usage?.prompt_tokens,
        outputTokens: raw.usage?.completion_tokens,
        totalTokens: raw.usage?.total_tokens
      }
    };
    this._lastUsage = result.usage;
    return result;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this._lastUsage = undefined;
    const response = await this.fetchImpl(this.url(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(request, true))
    });

    await ensureOk(this.provider, response);

    const pendingToolCalls = new Map<number, StreamingToolCallAccumulator>();
    let usage: LlmUsage | undefined;

    for await (const event of parseSse(response)) {
      if (event.data === '[DONE]') {
        yield* flushToolCalls(pendingToolCalls);
        this._lastUsage = usage;
        yield { type: 'done', ...(usage ? { usage } : {}) };
        return;
      }

      const parsed = JSON.parse(event.data) as OpenAiStreamResponse;
      if (parsed.usage) {
        usage = {
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens,
          totalTokens: parsed.usage.total_tokens
        };
      }
      const delta = parsed.choices?.[0]?.delta;
      const thinking = extractOpenAiThinking(delta);
      if (thinking) {
        yield { type: 'thinking-delta', text: thinking };
      }
      const text = delta?.content;
      if (text) {
        yield { type: 'text-delta', text };
      }
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const accumulator = pendingToolCalls.get(index) ?? { argumentsText: '' };
        if (fragment.id) {
          accumulator.id = fragment.id;
        }
        if (fragment.function?.name) {
          accumulator.name = fragment.function.name;
        }
        if (fragment.function?.arguments) {
          accumulator.argumentsText += fragment.function.arguments;
        }
        pendingToolCalls.set(index, accumulator);
      }
    }

    yield* flushToolCalls(pendingToolCalls);
    this._lastUsage = usage;
    yield { type: 'done', ...(usage ? { usage } : {}) };
  }

  private url(): string {
    return joinUrl(this.baseUrl, '/chat/completions');
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.apiKey}`,
      'content-type': 'application/json'
    };
  }

  private body(request: LlmRequest, stream: boolean): Record<string, unknown> {
    // 不主动传 max_tokens，避免 Runtime 人为截断长回复；调用方显式传入时才限制
    const body: Record<string, unknown> = {
      model: request.model ?? this._model,
      messages: request.messages.map(toOpenAiMessage),
      stream
    };
    if (stream) {
      body.stream_options = { include_usage: true };
    }
    if (request.tools?.length) {
      body.tools = request.tools.map(toOpenAiTool);
    }
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.topP !== undefined) {
      body.top_p = request.topP;
    }
    return body;
  }
}

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content
    };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input)
        }
      }))
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

function toOpenAiTool(tool: LlmToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} }
    }
  };
}

function parseToolCalls(raw: OpenAiChatResponse): LlmToolCall[] | undefined {
  const calls = raw.choices?.[0]?.message?.tool_calls
    ?.filter((call) => call.type === 'function' && call.id && call.function?.name)
    .map((call) => ({
      id: call.id as string,
      name: call.function?.name as string,
      input: parseToolArguments(call.function?.arguments)
    }));

  return calls && calls.length > 0 ? calls : undefined;
}

function* flushToolCalls(
  pending: Map<number, StreamingToolCallAccumulator>
): Iterable<LlmStreamChunk> {
  const indices = [...pending.keys()].sort((left, right) => left - right);
  for (const index of indices) {
    const accumulator = pending.get(index);
    if (!accumulator?.id || !accumulator.name) {
      continue;
    }
    yield {
      type: 'tool-call',
      call: {
        id: accumulator.id,
        name: accumulator.name,
        input: parseToolArguments(accumulator.argumentsText || undefined)
      }
    };
  }
  pending.clear();
}

function extractOpenAiThinking(
  source:
    | {
        reasoning_content?: string | null;
        reasoning?: string | null;
      }
    | null
    | undefined
): string {
  if (!source) {
    return '';
  }
  // 空串不算有效 thinking，允许回退到 reasoning 别名。
  return source.reasoning_content || source.reasoning || '';
}

function parseToolArguments(value: string | undefined): unknown {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
