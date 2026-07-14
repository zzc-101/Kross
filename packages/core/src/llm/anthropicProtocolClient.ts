import { ensureOk, defaultFetch, joinUrl } from './http';
import { parseSse } from './sse';
import {
  DEFAULT_THINKING_EFFORT,
  type ThinkingEffort
} from './thinkingEffort';
import type {
  AnthropicProtocolClientConfig,
  LlmClient,
  LlmChatMessage,
  LlmFetch,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
  LlmToolCall,
  LlmToolDefinition,
  LlmToolMessage,
  LlmUsage
} from './types';
import { resolveModelContextWindow } from './modelContextWindows';

interface AnthropicMessageResponse {
  model?: string;
  content?: Array<{
    type: string;
    text?: string;
    /** extended thinking */
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface AnthropicStreamResponse {
  type?: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  error?: {
    type?: string;
    message?: string;
  };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface StreamingToolUseAccumulator {
  id: string;
  name: string;
  inputJson: string;
}

export class AnthropicProtocolClient implements LlmClient {
  readonly provider = 'anthropic' as const;
  private _model: string;
  private _thinkingEffort: ThinkingEffort;
  private _lastUsage: LlmUsage | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: LlmFetch;
  private readonly anthropicVersion: string;

  constructor(private readonly config: AnthropicProtocolClientConfig) {
    this._model = config.model;
    this._thinkingEffort = config.thinkingEffort ?? DEFAULT_THINKING_EFFORT;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
    this.fetchImpl = config.fetch ?? defaultFetch();
    this.anthropicVersion = config.anthropicVersion ?? '2023-06-01';
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
    const raw = (await response.json()) as AnthropicMessageResponse;
    const inputTokens = raw.usage?.input_tokens;
    const outputTokens = raw.usage?.output_tokens;

    const thinking = extractAnthropicThinking(raw);
    const result: LlmResponse = {
      provider: this.provider,
      model: raw.model ?? request.model ?? this._model,
      text:
        raw.content
          ?.filter((item) => item.type === 'text')
          .map((item) => item.text ?? '')
          .join('') ?? '',
      thinking: thinking || undefined,
      raw,
      toolCalls: parseToolCalls(raw),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens:
          inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined
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

    const pendingToolUses = new Map<number, StreamingToolUseAccumulator>();
    let usage: LlmUsage | undefined;

    for await (const event of parseSse(response)) {
      if (event.event === 'message_stop') {
        this._lastUsage = usage;
        yield { type: 'done', ...(usage ? { usage } : {}) };
        return;
      }

      const parsed = JSON.parse(event.data) as AnthropicStreamResponse;
      const eventUsage = parsed.message?.usage ?? parsed.usage;
      if (eventUsage) {
        const inputTokens = eventUsage.input_tokens ?? usage?.inputTokens;
        const outputTokens = eventUsage.output_tokens ?? usage?.outputTokens;
        usage = {
          inputTokens,
          outputTokens,
          totalTokens:
            inputTokens !== undefined && outputTokens !== undefined
              ? inputTokens + outputTokens
              : undefined
        };
      }
      if (parsed.type === 'error' || parsed.error) {
        throw new Error(
          `anthropic stream error: ${parsed.error?.message ?? 'unknown error'}`
        );
      }
      if (
        parsed.type === 'content_block_start' &&
        parsed.content_block?.type === 'tool_use' &&
        parsed.content_block.id &&
        parsed.content_block.name
      ) {
        pendingToolUses.set(parsed.index ?? 0, {
          id: parsed.content_block.id,
          name: parsed.content_block.name,
          inputJson: ''
        });
        continue;
      }
      if (
        parsed.type === 'content_block_delta' &&
        parsed.delta?.type === 'input_json_delta'
      ) {
        const accumulator = pendingToolUses.get(parsed.index ?? 0);
        if (accumulator) {
          accumulator.inputJson += parsed.delta.partial_json ?? '';
        }
        continue;
      }
      if (parsed.type === 'content_block_stop') {
        const accumulator = pendingToolUses.get(parsed.index ?? 0);
        if (accumulator) {
          pendingToolUses.delete(parsed.index ?? 0);
          yield {
            type: 'tool-call',
            call: {
              id: accumulator.id,
              name: accumulator.name,
              input: parseToolUseInput(accumulator.inputJson)
            }
          };
        }
        continue;
      }
      if (
        parsed.type === 'content_block_delta' &&
        parsed.delta?.type === 'thinking_delta' &&
        parsed.delta.thinking
      ) {
        yield { type: 'thinking-delta', text: parsed.delta.thinking };
        continue;
      }
      if (
        parsed.type === 'content_block_delta' &&
        parsed.delta?.type === 'text_delta' &&
        parsed.delta.text
      ) {
        yield { type: 'text-delta', text: parsed.delta.text };
      }
    }

    this._lastUsage = usage;
    yield { type: 'done', ...(usage ? { usage } : {}) };
  }

  private url(): string {
    return joinUrl(
      this.baseUrl,
      baseUrlIncludesVersion(this.baseUrl) ? '/messages' : '/v1/messages'
    );
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'anthropic-version': this.anthropicVersion,
      'content-type': 'application/json'
    };

    if (this.config.authToken) {
      return {
        ...headers,
        authorization: `Bearer ${this.config.authToken}`
      };
    }

    if (this.config.apiKey) {
      return {
        ...headers,
        'x-api-key': this.config.apiKey
      };
    }

    throw new Error('Anthropic protocol requires apiKey or authToken');
  }

  private body(request: LlmRequest, stream: boolean): Record<string, unknown> {
    const { system, messages } = splitSystemMessages(request.messages);

    // Anthropic 要求必填 max_tokens；未指定时用大上限，不人为截断正常长回复
    const body: Record<string, unknown> = {
      model: request.model ?? this._model,
      system,
      messages,
      max_tokens: request.maxTokens ?? 32_768,
      stream
    };
    if (request.tools?.length) {
      body.tools = request.tools.map(toAnthropicTool);
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

function splitSystemMessages(messages: LlmMessage[]): {
  system?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
  }>;
} {
  const systemMessages = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content);

  return {
    system: systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined,
    messages: messages
      .filter(isAnthropicMessage)
      .map(toAnthropicMessage)
  };
}

type AnthropicInputMessage =
  | (LlmChatMessage & { role: 'user' | 'assistant' })
  | LlmToolMessage;

function isAnthropicMessage(message: LlmMessage): message is AnthropicInputMessage {
  return message.role === 'user' || message.role === 'assistant' || message.role === 'tool';
}

function toAnthropicMessage(message: AnthropicInputMessage): {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
} {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content
        }
      ]
    };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    const content: Array<Record<string, unknown>> = [];
    if (message.content.trim().length > 0) {
      content.push({ type: 'text', text: message.content });
    }
    content.push(
      ...message.toolCalls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input
      }))
    );

    return {
      role: 'assistant',
      content
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

function toAnthropicTool(tool: LlmToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ?? { type: 'object', properties: {} }
  };
}

function parseToolCalls(raw: AnthropicMessageResponse): LlmToolCall[] | undefined {
  const calls = raw.content
    ?.filter((item) => item.type === 'tool_use' && item.id && item.name)
    .map((item) => ({
      id: item.id as string,
      name: item.name as string,
      input: item.input ?? {}
    }));

  return calls && calls.length > 0 ? calls : undefined;
}

function extractAnthropicThinking(raw: AnthropicMessageResponse): string {
  return (
    raw.content
      ?.filter((item) => item.type === 'thinking')
      .map((item) => item.thinking ?? '')
      .join('') ?? ''
  );
}

function parseToolUseInput(inputJson: string): unknown {
  if (inputJson.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(inputJson);
  } catch {
    return inputJson;
  }
}

function baseUrlIncludesVersion(baseUrl: string): boolean {
  return /\/v\d+\/?$/.test(baseUrl);
}
