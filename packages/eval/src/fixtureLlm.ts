import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk
} from '@kross/core';

import type { FixtureResponse } from './schema';

export class FixtureLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly model = 'fixture-script-v1';
  readonly contextWindow = 64_000;
  readonly requests: LlmRequest[] = [];
  private index = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(private readonly responses: FixtureResponse[]) {}

  get usage(): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens
    };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return this.nextResponse();
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    const response = this.nextResponse();
    if (response.thinking) {
      yield { type: 'thinking-delta', text: response.thinking };
    }
    if (response.text) {
      yield { type: 'text-delta', text: response.text };
    }
    for (const call of response.toolCalls ?? []) {
      yield { type: 'tool-call', call };
    }
    yield { type: 'done', usage: response.usage };
  }

  private nextResponse(): LlmResponse {
    const scripted = this.responses[this.index];
    if (!scripted) {
      throw new Error(
        `Fixture LLM exhausted after ${this.index} responses`
      );
    }
    this.index += 1;
    this.inputTokens += scripted.usage.inputTokens;
    this.outputTokens += scripted.usage.outputTokens;
    return {
      provider: this.provider,
      model: this.model,
      text: scripted.text,
      thinking: scripted.thinking,
      toolCalls: scripted.toolCalls,
      usage: {
        ...scripted.usage,
        totalTokens:
          scripted.usage.inputTokens + scripted.usage.outputTokens
      },
      raw: { fixtureResponse: this.index }
    };
  }
}
