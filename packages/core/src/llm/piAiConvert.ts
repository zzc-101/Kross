import { Type, type Context, type Message, type Tool, type Usage } from '@earendil-works/pi-ai';

import type {
  LlmChatMessage,
  LlmMessage,
  LlmProvider,
  LlmResponse,
  LlmStreamChunk,
  LlmToolCall,
  LlmToolDefinition,
  LlmUsage
} from './types';

export interface ConvertContextOptions {
  provider: LlmProvider;
  model: string;
  api: string;
}

export function toPiContext(
  messages: LlmMessage[],
  tools: LlmToolDefinition[] | undefined,
  options: ConvertContextOptions
): Context {
  const systemParts: string[] = [];
  const piMessages: Message[] = [];
  const now = Date.now();

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) {
        systemParts.push(message.content);
      }
      continue;
    }

    if (message.role === 'user') {
      piMessages.push({
        role: 'user',
        content: message.content,
        timestamp: now
      });
      continue;
    }

    if (message.role === 'assistant') {
      piMessages.push(
        toPiAssistantMessage(message as LlmChatMessage & { role: 'assistant' }, options, now)
      );
      continue;
    }

    if (message.role === 'tool') {
      piMessages.push({
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: message.name,
        content: [{ type: 'text', text: message.content }],
        isError: false,
        timestamp: now
      });
    }
  }

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: piMessages,
    tools: tools?.map(toPiTool)
  };
}

export function toPiTool(tool: LlmToolDefinition): Tool {
  const parameters =
    tool.parameters && typeof tool.parameters === 'object'
      ? tool.parameters
      : { type: 'object', properties: {} };

  return {
    name: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(parameters as Record<string, unknown>)
  };
}

export function fromPiAssistantMessage(
  message: {
    provider: string;
    model: string;
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
      | { type: string; [key: string]: unknown }
    >;
    usage?: Usage;
  },
  fallbackProvider: LlmProvider
): LlmResponse {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: LlmToolCall[] = [];

  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinkingParts.push(block.thinking);
      continue;
    }
    if (block.type === 'toolCall') {
      const call = block as {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      };
      toolCalls.push({
        id: call.id,
        name: call.name,
        input: call.arguments ?? {}
      });
    }
  }

  const thinking = thinkingParts.join('');
  return {
    provider: normalizeProvider(message.provider, fallbackProvider),
    model: message.model,
    text: textParts.join(''),
    thinking: thinking || undefined,
    raw: message,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: fromPiUsage(message.usage)
  };
}

export function mapPiStreamEvent(
  event: {
    type: string;
    delta?: string;
    toolCall?: {
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    error?: { errorMessage?: string };
    reason?: string;
    message?: { usage?: Usage };
  }
): LlmStreamChunk | { type: 'error'; message: string } | undefined {
  switch (event.type) {
    case 'text_delta':
      return event.delta ? { type: 'text-delta', text: event.delta } : undefined;
    case 'thinking_delta':
      return event.delta ? { type: 'thinking-delta', text: event.delta } : undefined;
    case 'toolcall_end':
      if (!event.toolCall) {
        return undefined;
      }
      return {
        type: 'tool-call',
        call: {
          id: event.toolCall.id,
          name: event.toolCall.name,
          input: event.toolCall.arguments ?? {}
        }
      };
    case 'done':
      return {
        type: 'done',
        ...(event.message?.usage
          ? { usage: fromPiUsage(event.message.usage) }
          : {})
      };
    case 'error':
      return {
        type: 'error',
        message:
          event.error?.errorMessage ??
          (event.reason === 'aborted' ? 'request aborted' : 'provider error')
      };
    default:
      return undefined;
  }
}

function toPiAssistantMessage(
  message: LlmChatMessage & { role: 'assistant' },
  options: ConvertContextOptions,
  timestamp: number
): Message {
  const content: Array<
    | { type: 'text'; text: string }
    | {
        type: 'toolCall';
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }
  > = [];

  if (message.content.trim()) {
    content.push({ type: 'text', text: message.content });
  }

  for (const call of message.toolCalls ?? []) {
    content.push({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: toArgumentRecord(call.input)
    });
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    role: 'assistant',
    content,
    api: options.api,
    provider: options.provider,
    model: options.model,
    usage: emptyUsage(),
    stopReason: (message.toolCalls?.length ?? 0) > 0 ? 'toolUse' : 'stop',
    timestamp
  };
}

function toArgumentRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { value: input };
    }
  }
  return input === undefined ? {} : { value: input };
}

function fromPiUsage(usage: Usage | undefined): LlmUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function normalizeProvider(
  provider: string,
  fallback: LlmProvider
): LlmProvider {
  if (
    provider === 'openai' ||
    provider === 'anthropic' ||
    provider === 'openrouter' ||
    provider === 'deepseek' ||
    provider === 'xai'
  ) {
    return provider;
  }
  return fallback;
}
