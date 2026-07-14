import { z } from 'zod';

import {
  llmProviderSchema,
  type LlmProvider
} from './llmProviders';
import type { ThinkingEffort } from './thinkingEffort';

export { llmProviderSchema, type LlmProvider };
export type { ThinkingEffort };

export const llmRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type LlmRole = z.infer<typeof llmRoleSchema>;

export type LlmMessage = LlmChatMessage | LlmToolMessage;

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
  /** Per-request override; falls back to client default. */
  thinkingEffort?: ThinkingEffort;
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
      usage?: LlmUsage;
    };

export interface LlmClient {
  readonly provider: LlmProvider;
  /** 当前默认模型名，供 TUI 状态栏展示。 */
  readonly model?: string;
  /** 默认思考强度（状态栏与请求共用）。 */
  readonly thinkingEffort?: ThinkingEffort;
  /** 配置后的模型上下文窗口。 */
  readonly contextWindow?: number;
  /** 最近一次模型响应返回的真实 usage。 */
  readonly lastUsage?: LlmUsage;
  /** 会话内切换模型 id（同 provider）。 */
  setModel?(model: string): void;
  setThinkingEffort?(effort: ThinkingEffort): void;
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
  thinkingEffort?: ThinkingEffort;
  contextWindow?: number;
}

export interface OpenAiFamilyClientConfig extends BaseLlmClientConfig {
  /** Defaults to openai when omitted (native client convenience). */
  provider?: 'openai' | 'openrouter' | 'deepseek' | 'xai';
  apiKey: string;
}

export interface AnthropicProtocolClientConfig extends BaseLlmClientConfig {
  provider?: 'anthropic';
  anthropicVersion?: string;
}

export type LlmClientConfig =
  | (OpenAiFamilyClientConfig & {
      provider: 'openai' | 'openrouter' | 'deepseek' | 'xai';
    })
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
