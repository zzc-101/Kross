import { z } from 'zod';

export const llmProviderSchema = z.enum(['openai', 'anthropic']);
export type LlmProvider = z.infer<typeof llmProviderSchema>;

export const llmRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type LlmRole = z.infer<typeof llmRoleSchema>;

export type LlmMessage =
  | LlmChatMessage
  | LlmToolMessage;

export interface LlmChatMessage {
  role: Exclude<LlmRole, 'tool'>;
  content: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
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
  /** 模型思考/推理过程（若协议返回）；不计入最终对用户回复正文。 */
  thinking?: string;
  raw: unknown;
  toolCalls?: LlmToolCall[];
  usage?: LlmUsage;
}

export type LlmStreamChunk =
  | {
      type: 'text-delta';
      text: string;
    }
  | {
      type: 'thinking-delta';
      text: string;
    }
  | {
      type: 'tool-call';
      call: LlmToolCall;
    }
  | {
      type: 'done';
    };

export interface LlmClient {
  readonly provider: LlmProvider;
  /** 当前默认模型名，供 TUI 状态栏展示。 */
  readonly model?: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk>;
}

export type LlmFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface BaseLlmClientConfig {
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  model: string;
  fetch?: LlmFetch;
}

export interface OpenAiProtocolClientConfig extends BaseLlmClientConfig {
  provider?: 'openai';
  apiKey: string;
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
