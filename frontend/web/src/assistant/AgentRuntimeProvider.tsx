import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike
} from '@assistant-ui/react';

import { applyChannelEvent } from '../api/channelEvents';
import { AgentApiClient } from '../api/client';
import type { AgentMessage, MessagePart } from '../api/types';

type AssistantMessagePart = Exclude<ThreadMessageLike['content'], string>[number];

export type AgentContextUsage = NonNullable<AgentMessage['contextUsage']>;
export const AgentContextUsageContext = createContext<AgentContextUsage | undefined>(undefined);

function toThreadMessage(message: AgentMessage): ThreadMessageLike {
  const role = message.role === 'agent' ? 'assistant' : message.role;
  const parts = message.parts && message.parts.length > 0
    ? message.parts
    : (message.content ? [{ type: 'text' as const, text: message.content }] : []);
  const content = message.status === 'failed' && parts.length === 0
    ? [{ type: 'text' as const, text: message.errorSummary || '这一轮失败了' }]
    : parts.map(toAssistantPart);
  return {
    id: message.id,
    role,
    createdAt: new Date(message.createdAt),
    ...(role === 'assistant' ? {
      status: message.status === 'failed'
        ? { type: 'incomplete' as const, reason: 'error' as const, error: message.errorSummary || '消息处理失败' }
        : message.status === 'queued' || message.status === 'processing'
          ? { type: 'running' as const }
          : { type: 'complete' as const, reason: 'stop' as const }
    } : {}),
    content
  };
}

function toAssistantPart(part: MessagePart): AssistantMessagePart {
  if (part.type === 'reasoning') {
    return { type: 'reasoning', text: part.text };
  }
  if (part.type === 'tool') {
    return {
      type: 'tool-call',
      toolCallId: part.id,
      toolName: part.name,
      args: part.input && typeof part.input === 'object' ? part.input as Record<string, unknown> : { value: part.input },
      argsText: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}, null, 2),
      result: part.result,
      isError: part.status === 'failed',
      approval: part.approval ? {
        id: part.approval.id,
        approved: part.approval.approved,
        reason: part.approval.reason
      } : undefined,
      status: part.status === 'running'
        ? { type: 'running' }
        : part.status === 'failed'
          ? { type: 'incomplete', reason: 'error' }
          : { type: 'complete' }
    } as AssistantMessagePart;
  }
  return { type: 'text', text: part.text };
}

export function AgentRuntimeProvider({
  api,
  conversationId,
  onConversationsChange,
  children
}: {
  api: AgentApiClient;
  conversationId?: string;
  onConversationsChange(): Promise<void>;
  children: ReactNode;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  const refreshMessages = useCallback(async (id: string) => {
    const items = await api.listMessages(id);
    setMessages((current) => reconcileMessageSnapshot(current, items));
    setIsRunning(items.some((item) => item.status === 'queued' || item.status === 'processing'));
  }, [api]);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setIsRunning(false);
      return;
    }
    setMessages([]);
    setIsRunning(false);
    const abort = new AbortController();
    const connect = async () => {
      while (!abort.signal.aborted) {
        try {
          await refreshMessages(conversationId);
          if (abort.signal.aborted) return;
          await api.subscribeConversationEvents(conversationId, (event) => {
            setMessages((current) => {
              const next = applyChannelEvent(current, event);
              setIsRunning(next.some((item) => item.status === 'queued' || item.status === 'processing'));
              return next;
            });
            if (event.type === 'message.upsert') {
              void onConversationsChange();
            }
          }, abort.signal);
        } catch {
          if (abort.signal.aborted) return;
        }
        if (abort.signal.aborted) return;
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
      }
    };
    void connect();
    return () => abort.abort();
  }, [api, conversationId, onConversationsChange, refreshMessages]);

  const onNew = useCallback(async (message: AppendMessage) => {
    if (!conversationId) throw new Error('No conversation selected');
    const textPart = message.content.find((part) => part.type === 'text');
    if (!textPart || textPart.type !== 'text' || !textPart.text.trim()) {
      throw new Error('Only text messages are supported');
    }
    setIsRunning(true);
    const created = await api.appendMessage(conversationId, textPart.text.trim());
    setMessages((current) => applyChannelEvent(current, {
      type: 'message.upsert',
      conversationId,
      messageId: created.id,
      data: { message: created }
    }));
    await onConversationsChange();
  }, [api, conversationId, onConversationsChange]);

  const runtime = useExternalStoreRuntime({
    isRunning,
    isSendDisabled: isRunning,
    messages,
    convertMessage: toThreadMessage,
    onNew,
    onCancel: async () => undefined,
    onRespondToToolApproval: async ({ approvalId, approved, reason }) => {
      if (!conversationId) throw new Error('No conversation selected');
      await api.resolveApproval(conversationId, approvalId, { approved, reason });
    },
    unstable_capabilities: { copy: true }
  });

  const contextUsage = useMemo(
    () => [...messages].reverse().find((message) => message.contextUsage)?.contextUsage,
    [messages]
  );

  return (
    <AgentContextUsageContext.Provider value={contextUsage}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </AgentContextUsageContext.Provider>
  );
}

export function reconcileMessageSnapshot(current: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const currentById = new Map(current.map((message) => [message.id, message]));
  return incoming.map((message) => {
    const streamed = currentById.get(message.id);
    if (
      message.status === 'processing'
      && streamed?.status === 'processing'
      && messageRichness(streamed) > messageRichness(message)
    ) {
      return {
        ...message,
        content: streamed.content,
        parts: streamed.parts,
        contextUsage: message.contextUsage ?? streamed.contextUsage
      };
    }
    return message;
  });
}

function messageRichness(message: AgentMessage): number {
  if (message.parts?.length) {
    return JSON.stringify(message.parts).length;
  }
  return message.content.length;
}
