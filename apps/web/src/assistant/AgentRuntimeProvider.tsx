import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike
} from '@assistant-ui/react';

import { AgentApiClient } from '../api/client';
import type { Agent, AgentMessage, Conversation } from '../api/types';

const POLL_MS = 1_200;

function toThreadMessage(message: AgentMessage): ThreadMessageLike {
  const role = message.role === 'agent' ? 'assistant' : message.role;
  const text = message.status === 'failed'
    ? (message.errorSummary || message.content || '这一轮失败了')
    : message.content;
  return {
    id: message.id,
    role,
    content: [{ type: 'text', text: text || (message.status === 'processing' ? '正在思考…' : '') }]
  };
}

export function AgentRuntimeProvider({
  api,
  conversations,
  conversationId,
  onConversationsChange,
  onSelectConversation,
  onCreateConversation,
  children
}: {
  api: AgentApiClient;
  conversations: Conversation[];
  conversationId?: string;
  onConversationsChange(): Promise<void>;
  onSelectConversation(id: string): void;
  onCreateConversation(): Promise<string>;
  children: ReactNode;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== undefined) {
      window.clearInterval(pollRef.current);
      pollRef.current = undefined;
    }
  }, []);

  const refreshMessages = useCallback(async (id: string) => {
    const items = await api.listMessages(id);
    setMessages(items);
    const pending = items.some((item) => item.status === 'queued' || item.status === 'processing');
    setIsRunning(pending);
    return pending;
  }, [api]);

  useEffect(() => {
    stopPolling();
    if (!conversationId) {
      setMessages([]);
      setIsRunning(false);
      return;
    }
    void refreshMessages(conversationId).then((pending) => {
      if (!pending) return;
      pollRef.current = window.setInterval(() => {
        void refreshMessages(conversationId).then((still) => {
          if (!still) stopPolling();
        });
      }, POLL_MS);
    });
    return stopPolling;
  }, [conversationId, refreshMessages, stopPolling]);

  const onNew = useCallback(async (message: AppendMessage) => {
    if (!conversationId) throw new Error('No conversation selected');
    const textPart = message.content.find((part) => part.type === 'text');
    if (!textPart || textPart.type !== 'text' || !textPart.text.trim()) {
      throw new Error('Only text messages are supported');
    }
    setIsRunning(true);
    await api.appendMessage(conversationId, textPart.text.trim());
    await onConversationsChange();
    const pending = await refreshMessages(conversationId);
    if (pending) {
      stopPolling();
      pollRef.current = window.setInterval(() => {
        void refreshMessages(conversationId).then((still) => {
          if (!still) {
            stopPolling();
            void onConversationsChange();
          }
        });
      }, POLL_MS);
    } else {
      setIsRunning(false);
    }
  }, [api, conversationId, onConversationsChange, refreshMessages, stopPolling]);

  const threadListAdapter = useMemo<ExternalStoreThreadListAdapter>(() => ({
    threadId: conversationId,
    threads: conversations.map((item) => ({
      id: item.id,
      status: 'regular' as const,
      title: item.title
    })),
    archivedThreads: [],
    onSwitchToNewThread: () => {
      void onCreateConversation().then((id) => onSelectConversation(id));
    },
    onSwitchToThread: (id) => onSelectConversation(id),
    onRename: (id, title) => {
      void api.patchConversation(id, { title }).then(() => onConversationsChange());
    },
    onArchive: (id) => {
      void api.patchConversation(id, { archived: true }).then(async () => {
        await onConversationsChange();
        if (id === conversationId) {
          const next = conversations.find((item) => item.id !== id);
          if (next) onSelectConversation(next.id);
          else onSelectConversation(await onCreateConversation());
        }
      });
    }
  }), [api, conversationId, conversations, onConversationsChange, onCreateConversation, onSelectConversation]);

  const runtime = useExternalStoreRuntime({
    isRunning,
    isSendDisabled: isRunning,
    messages,
    convertMessage: toThreadMessage,
    onNew,
    onCancel: async () => undefined,
    adapters: { threadList: threadListAdapter }
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

export function agentStatusLabel(agent?: Agent): string {
  switch (agent?.status) {
    case 'running':
    case 'starting':
      return '运行中';
    case 'stopping':
      return '正在休眠';
    case 'error':
      return '异常';
    default:
      return '已休眠';
  }
}
