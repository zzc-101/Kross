import { ensureOk, defaultFetch, joinUrl } from './http';
import { parseSse } from './sse';
import type {
  LlmClient,
  LlmFetch,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
  LlmToolCall,
  LlmToolDefinition,
  OpenAiProtocolClientConfig
} from './types';

interface OpenAiChatResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
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
    delta?: { content?: string | null };
  }>;
}

export class OpenAiProtocolClient implements LlmClient {
  readonly provider = 'openai' as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: LlmFetch;

  constructor(private readonly config: OpenAiProtocolClientConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.fetchImpl = config.fetch ?? defaultFetch();
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.fetchImpl(this.url(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(request, false))
    });

    await ensureOk(this.provider, response);
    const raw = (await response.json()) as OpenAiChatResponse;

    return {
      provider: this.provider,
      model: raw.model ?? request.model ?? this.config.model,
      text: raw.choices?.[0]?.message?.content ?? '',
      raw,
      toolCalls: parseToolCalls(raw),
      usage: {
        inputTokens: raw.usage?.prompt_tokens,
        outputTokens: raw.usage?.completion_tokens,
        totalTokens: raw.usage?.total_tokens
      }
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const response = await this.fetchImpl(this.url(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(request, true))
    });

    await ensureOk(this.provider, response);

    for await (const event of parseSse(response)) {
      if (event.data === '[DONE]') {
        yield { type: 'done' };
        return;
      }

      const parsed = JSON.parse(event.data) as OpenAiStreamResponse;
      const text = parsed.choices?.[0]?.delta?.content;
      if (text) {
        yield { type: 'text-delta', text };
      }
    }

    yield { type: 'done' };
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
    return {
      model: request.model ?? this.config.model,
      messages: request.messages.map(toOpenAiMessage),
      tools: request.tools?.map(toOpenAiTool),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      top_p: request.topP,
      stream
    };
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
