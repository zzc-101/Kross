import type { AgentMessage, MessagePart } from './types';

export interface ChannelEvent {
  type: string;
  conversationId: string;
  messageId?: string;
  data?: {
    message?: AgentMessage;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    content?: string;
    ok?: boolean;
  };
}

export function applyChannelEvent(messages: AgentMessage[], event: ChannelEvent): AgentMessage[] {
  if (event.type === 'message.upsert' && event.data?.message) {
    return upsertMessage(messages, event.data.message);
  }
  const messageId = event.messageId;
  if (!messageId) return messages;
  const index = messages.findIndex((item) => item.id === messageId);
  const current: AgentMessage = index >= 0
    ? messages[index]!
    : {
        id: messageId,
        conversationId: event.conversationId,
        role: 'agent' as const,
        content: '',
        parts: [],
        status: 'processing' as const,
        createdAt: new Date().toISOString()
      };
  const next = applyPartEvent(current, event);
  if (index < 0) return [...messages, next];
  const copy = messages.slice();
  copy[index] = next;
  return copy;
}

function applyPartEvent(message: AgentMessage, event: ChannelEvent): AgentMessage {
  const parts = [...(message.parts ?? (message.content ? [{ type: 'text' as const, text: message.content }] : []))];
  if (event.type === 'text-delta' && event.data?.text) {
    appendText(parts, event.data.text);
  } else if (event.type === 'thinking-delta' && event.data?.text) {
    appendReasoning(parts, event.data.text);
  } else if (event.type === 'tool-call' && event.data?.id) {
    upsertTool(parts, event.data.id, event.data.name || 'tool', event.data.input, 'running');
  } else if (event.type === 'tool-result' && event.data?.id) {
    completeTool(
      parts,
      event.data.id,
      event.data.name || 'tool',
      event.data.content || '',
      event.data.ok !== false
    );
  }
  const content = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  return { ...message, parts, content, status: message.status === 'done' || message.status === 'failed' ? message.status : 'processing' };
}

function upsertMessage(messages: AgentMessage[], incoming: AgentMessage): AgentMessage[] {
  const index = messages.findIndex((item) => item.id === incoming.id);
  if (index < 0) return [...messages, incoming];
  const copy = messages.slice();
  copy[index] = incoming;
  return copy;
}

function appendText(parts: MessagePart[], text: string): void {
  const last = parts[parts.length - 1];
  if (last?.type === 'text') {
    last.text += text;
    return;
  }
  parts.push({ type: 'text', text });
}

function appendReasoning(parts: MessagePart[], text: string): void {
  const last = parts[parts.length - 1];
  if (last?.type === 'reasoning') {
    last.text += text;
    return;
  }
  parts.push({ type: 'reasoning', text });
}

function upsertTool(
  parts: MessagePart[],
  id: string,
  name: string,
  input: unknown,
  status: 'running' | 'done' | 'failed'
): void {
  const existing = parts.find((part) => part.type === 'tool' && part.id === id);
  if (existing && existing.type === 'tool') {
    existing.name = name;
    existing.status = status;
    if (input !== undefined) existing.input = input;
    return;
  }
  parts.push({ type: 'tool', id, name, input, status });
}

function completeTool(
  parts: MessagePart[],
  id: string,
  name: string,
  result: string,
  ok: boolean
): void {
  const existing = parts.find((part) => part.type === 'tool' && part.id === id);
  if (existing && existing.type === 'tool') {
    existing.name = name;
    existing.result = result;
    existing.status = ok ? 'done' : 'failed';
    return;
  }
  parts.push({ type: 'tool', id, name, result, status: ok ? 'done' : 'failed' });
}
