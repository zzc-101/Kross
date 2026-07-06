import { z } from 'zod';

export const llmProviderSchema = z.enum(['openai', 'anthropic']);
export type LlmProvider = z.infer<typeof llmProviderSchema>;

export const llmRoleSchema = z.enum(['system', 'user', 'assistant']);
export type LlmRole = z.infer<typeof llmRoleSchema>;

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  metadata?: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmResponse {
  provider: LlmProvider;
  model: string;
  text: string;
  raw: unknown;
  usage?: LlmUsage;
}

export type LlmStreamChunk =
  | {
      type: 'text-delta';
      text: string;
    }
  | {
      type: 'done';
    };

export interface LlmClient {
  readonly provider: LlmProvider;
  complete(request: LlmRequest): Promise<LlmResponse>;
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk>;
}

export type LlmFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface BaseLlmClientConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  fetch?: LlmFetch;
}

export interface OpenAiProtocolClientConfig extends BaseLlmClientConfig {
  provider?: 'openai';
}

export interface AnthropicProtocolClientConfig extends BaseLlmClientConfig {
  provider?: 'anthropic';
  anthropicVersion?: string;
}

export type LlmClientConfig =
  | (OpenAiProtocolClientConfig & { provider: 'openai' })
  | (AnthropicProtocolClientConfig & { provider: 'anthropic' });

export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly provider: LlmProvider,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}
