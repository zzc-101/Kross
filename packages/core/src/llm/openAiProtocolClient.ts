import { ensureOk, defaultFetch, joinUrl } from './http';
import { parseSse } from './sse';
import type {
  LlmClient,
  LlmFetch,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
  OpenAiProtocolClientConfig
} from './types';

interface OpenAiChatResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
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
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      top_p: request.topP,
      stream
    };
  }
}
