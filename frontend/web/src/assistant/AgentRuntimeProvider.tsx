import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike
} from '@assistant-ui/react';

import { applyChannelEvent } from '../api/channelEvents';
import { AgentApiClient, isUnauthorizedError } from '../api/client';
import type { AgentMessage, MessagePart } from '../api/types';

type AssistantMessagePart = Exclude<ThreadMessageLike['content'], string>[number];

export type AgentContextUsage = NonNullable<AgentMessage['contextUsage']>;
export const AgentContextUsageContext = createContext<AgentContextUsage | undefined>(undefined);
export const WorkspaceApiContext = createContext<AgentApiClient | undefined>(undefined);
export const ComposerAttachmentsContext = createContext<{
  files: File[];
  add(files: File[]): void;
  remove(index: number): void;
}>({
  files: [],
  add: () => undefined,
  remove: () => undefined
});

const MAX_MESSAGE_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function isVisionFile(mimeType: string, name: string): boolean {
  const mime = mimeType.toLowerCase();
  if (['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'].includes(mime)) {
    return true;
  }
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
}

function toThreadMessage(message: AgentMessage): ThreadMessageLike {
  const role = message.role === 'agent' ? 'assistant' : message.role;
  const stored = message.parts ?? [];
  const files = stored.filter((part): part is Extract<MessagePart, { type: 'file' }> => part.type === 'file');
  const rest = stored.filter((part) => part.type !== 'file');
  const body = rest.length > 0
    ? rest
    : (message.content.trim() ? [{ type: 'text' as const, text: message.content }] : []);
  const parts = [...files, ...body];
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
  if (part.type === 'file') {
    if (isVisionFile(part.mimeType, part.name)) {
      return { type: 'image', image: `workspace:${part.path}`, filename: part.name } as AssistantMessagePart;
    }
    return {
      type: 'file',
      filename: part.name,
      mimeType: part.mimeType,
      data: `workspace:${part.path}`
    } as AssistantMessagePart;
  }
  return { type: 'text', text: part.text };
}

export function AgentRuntimeProvider({
  api,
  conversationId,
  onCreateConversation,
  onConversationCreated,
  onConversationsChange,
  onSessionExpired,
  children
}: {
  api: AgentApiClient;
  conversationId?: string;
  onCreateConversation(): Promise<string>;
  onConversationCreated(conversationId: string): void;
  onConversationsChange(): Promise<void>;
  onSessionExpired(): void;
  children: ReactNode;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const pendingFilesRef = useRef<File[]>([]);
  pendingFilesRef.current = pendingFiles;

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
        } catch (cause) {
          if (abort.signal.aborted) return;
          if (isUnauthorizedError(cause)) {
            onSessionExpired();
            return;
          }
        }
        if (abort.signal.aborted) return;
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
      }
    };
    void connect();
    return () => abort.abort();
  }, [api, conversationId, onConversationsChange, onSessionExpired, refreshMessages]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const textPart = message.content.find((part) => part.type === 'text');
    const text = textPart && textPart.type === 'text' ? textPart.text.replace(/\u200b/g, '').trim() : '';
    const attachments = pendingFilesRef.current;
    if (!text && attachments.length === 0) {
      throw new Error('请输入消息或添加附件');
    }
    setIsRunning(true);
    try {
      const uploaded = [];
      for (const file of attachments) {
        if (file.size > MAX_FILE_BYTES) {
          throw new Error(`${file.name} 超过 10MB`);
        }
        uploaded.push(await api.uploadWorkspaceFile('uploads', file));
      }
      const targetConversationId = conversationId ?? await onCreateConversation();
      const created = await api.appendMessage(
        targetConversationId,
        text,
        uploaded.map((file) => ({ path: file.path, mimeType: file.mimeType, name: file.name }))
      );
      setPendingFiles([]);
      setMessages((current) => applyChannelEvent(current, {
        type: 'message.upsert',
        conversationId: targetConversationId,
        messageId: created.id,
        data: { message: created }
      }));
      await onConversationsChange();
      if (!conversationId) onConversationCreated(targetConversationId);
    } catch (cause) {
      setIsRunning(false);
      throw cause;
    }
  }, [api, conversationId, onConversationCreated, onConversationsChange, onCreateConversation]);

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

  const attachments = useMemo(() => ({
    files: pendingFiles,
    add(files: File[]) {
      setPendingFiles((current) => [...current, ...files].slice(0, MAX_MESSAGE_FILES));
    },
    remove(index: number) {
      setPendingFiles((current) => current.filter((_, item) => item !== index));
    }
  }), [pendingFiles]);

  return (
    <AgentContextUsageContext.Provider value={contextUsage}>
      <WorkspaceApiContext.Provider value={api}>
        <ComposerAttachmentsContext.Provider value={attachments}>
          <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
        </ComposerAttachmentsContext.Provider>
      </WorkspaceApiContext.Provider>
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
