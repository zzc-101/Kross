import { useCallback, useEffect, useRef, useState } from 'react';

import {
  buildToolState,
  ensureToolItems,
  formatToolTitle,
  isAggregatableTool,
  type ChatMessage,
  type ToolCallState
} from '../ui';
import { MessagePaintCache } from '../ui/messagePaint';
import { mergeToolItem, toToolItem } from '../ui/toolDisplay';
import {
  createMessageUpdateBuffer,
  type MessageUpdateBuffer
} from './messageUpdateBuffer';

export interface UseAppMessagesOptions {
  initialMessages: ChatMessage[];
  initialNextMessageId: number;
  persistMessage: (message: ChatMessage) => void;
  resetToBottom: () => void;
}

export function useAppMessages({
  initialMessages,
  initialNextMessageId,
  persistMessage,
  resetToBottom
}: UseAppMessagesOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const latestMessagesRef = useRef(messages);
  latestMessagesRef.current = messages;

  const messageUpdateBufferRef = useRef<MessageUpdateBuffer | null>(null);
  if (messageUpdateBufferRef.current === null) {
    messageUpdateBufferRef.current = createMessageUpdateBuffer({
      onFlush: (updates) => {
        const current = latestMessagesRef.current;
        let changed = false;
        const next = current.map((message) => {
          const text = updates.get(message.id);
          if (text === undefined || text === message.text) {
            return message;
          }
          changed = true;
          return { ...message, text };
        });
        if (changed) {
          latestMessagesRef.current = next;
          setMessages(next);
        }
      }
    });
  }

  const enqueueMessageUpdate = useCallback((id: number, text: string) => {
    messageUpdateBufferRef.current?.enqueue(id, text);
  }, []);

  const flushMessageUpdates = useCallback(() => {
    messageUpdateBufferRef.current?.flush();
  }, []);

  useEffect(() => {
    return () => messageUpdateBufferRef.current?.cancel();
  }, []);

  const nextMessageIdRef = useRef(initialNextMessageId);
  /** tool call 关联键 → 消息 id，用于 in-place 更新卡片状态 */
  const toolMessageIdsRef = useRef(new Map<string, number>());
  const clickPaintCacheRef = useRef(new MessagePaintCache());

  const append = useCallback(
    (
      from: ChatMessage['from'],
      text: string,
      options: { expanded?: boolean } = {}
    ) => {
      const id = nextMessageIdRef.current;
      nextMessageIdRef.current += 1;
      const message: ChatMessage = {
        id,
        from,
        text,
        createdAt: new Date().toISOString(),
        expanded: options.expanded
      };
      setMessages((current) => [...current, message]);
      persistMessage(message);
      // 新消息时回到底部（跟读最新）
      resetToBottom();
      return id;
    },
    [persistMessage, resetToBottom]
  );

  const upsertToolMessage = useCallback((key: string, tool: ToolCallState) => {
    const extras = {
      detailLines: tool.detailLines,
      detailTruncated: tool.detailTruncated,
      linesAdded: tool.linesAdded,
      linesRemoved: tool.linesRemoved,
      summary: tool.summary
    };

    const existingId = toolMessageIdsRef.current.get(key);
    if (existingId !== undefined) {
      setMessages((current) =>
        current.map((message) => {
          if (message.id !== existingId || message.from !== 'tool' || !message.tool) {
            return message;
          }
          const items = mergeToolItem(
            ensureToolItems(message.tool),
            toToolItem(tool)
          );
          const merged = buildToolState(
            message.tool.name,
            tool.risk ?? message.tool.risk,
            items,
            {
              detailLines: tool.detailLines ?? message.tool.detailLines,
              detailTruncated:
                tool.detailTruncated ?? message.tool.detailTruncated,
              linesAdded: tool.linesAdded ?? message.tool.linesAdded,
              linesRemoved: tool.linesRemoved ?? message.tool.linesRemoved,
              summary: tool.summary ?? message.tool.summary
            }
          );
          return {
            ...message,
            from: 'tool' as const,
            text: formatToolTitle(merged),
            tool: merged
          };
        })
      );
      return existingId;
    }

    // React 的 setState updater 同步执行，便于拿到聚合后的 message id
    const holder = { id: -1 };
    setMessages((current) => {
      const last = current[current.length - 1];
      if (
        last?.from === 'tool' &&
        last.tool &&
        last.tool.name === tool.name &&
        isAggregatableTool(tool.name)
      ) {
        holder.id = last.id;
        const items = mergeToolItem(ensureToolItems(last.tool), toToolItem(tool));
        const merged = buildToolState(
          last.tool.name,
          tool.risk ?? last.tool.risk,
          items,
          {
            detailLines: tool.detailLines ?? last.tool.detailLines,
            detailTruncated:
              tool.detailTruncated ?? last.tool.detailTruncated,
            linesAdded: tool.linesAdded ?? last.tool.linesAdded,
            linesRemoved: tool.linesRemoved ?? last.tool.linesRemoved,
            summary: tool.summary ?? last.tool.summary
          }
        );
        return current.map((message) =>
          message.id === last.id
            ? {
                ...message,
                text: formatToolTitle(merged),
                tool: merged
              }
            : message
        );
      }

      const id = nextMessageIdRef.current;
      nextMessageIdRef.current += 1;
      holder.id = id;
      const state = buildToolState(tool.name, tool.risk, [toToolItem(tool)], extras);
      return [
        ...current,
        {
          id,
          from: 'tool' as const,
          text: formatToolTitle(state),
          createdAt: new Date().toISOString(),
          tool: state,
          expanded: false
        }
      ];
    });

    toolMessageIdsRef.current.set(key, holder.id);
    resetToBottom();
    return holder.id;
  }, [resetToBottom]);

  /** 冻结已结束 thinking 的耗时（Thought for Ns）。 */
  const finalizeThinkingDurations = useCallback(() => {
    setMessages((current) => {
      let changed = false;
      const next = current.map((message) => {
        if (
          message.from !== 'thinking' ||
          message.durationMs !== undefined ||
          !message.createdAt
        ) {
          return message;
        }
        const start = new Date(message.createdAt).getTime();
        if (Number.isNaN(start)) {
          return message;
        }
        changed = true;
        return {
          ...message,
          durationMs: Math.max(0, Date.now() - start)
        };
      });
      return changed ? next : current;
    });
  }, []);

  const toggleThinkingById = useCallback((messageId: number) => {
    setMessages((current) => {
      const index = current.findIndex(
        (message) => message.id === messageId && message.from === 'thinking'
      );
      if (index < 0) {
        return current;
      }
      const message = current[index];
      if (!message) {
        return current;
      }
      const next = current.slice();
      const durationMs =
        message.durationMs ??
        (message.createdAt
          ? Math.max(0, Date.now() - new Date(message.createdAt).getTime())
          : undefined);
      next[index] = {
        ...message,
        expanded: message.expanded !== true,
        durationMs
      };
      return next;
    });
  }, []);

  const toggleToolById = useCallback((messageId: number) => {
    setMessages((current) => {
      const index = current.findIndex(
        (message) => message.id === messageId && message.from === 'tool'
      );
      if (index < 0) {
        return current;
      }
      const message = current[index];
      if (!message) {
        return current;
      }
      const next = current.slice();
      next[index] = {
        ...message,
        expanded: message.expanded !== true
      };
      return next;
    });
  }, []);

  /** 切换最近一条 thinking 的展开/折叠（ctrl+o / 命令）。 */
  const toggleLastCollapsible = useCallback(() => {
    setMessages((current) => {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const message = current[index];
        if (!message || message.from !== 'thinking') {
          continue;
        }
        const next = current.slice();
        const durationMs =
          message.durationMs ??
          (message.createdAt
            ? Math.max(0, Date.now() - new Date(message.createdAt).getTime())
            : undefined);
        next[index] = {
          ...message,
          expanded: message.expanded !== true,
          durationMs
        };
        return next;
      }
      return current;
    });
  }, []);

  /** 切换最近一条工具组展开/折叠（Read N files 明细）。 */
  const toggleLastToolGroup = useCallback(() => {
    setMessages((current) => {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const message = current[index];
        if (!message || message.from !== 'tool') {
          continue;
        }
        const next = current.slice();
        next[index] = { ...message, expanded: message.expanded !== true };
        return next;
      }
      return current;
    });
  }, []);

  return {
    messages,
    setMessages,
    latestMessagesRef,
    nextMessageIdRef,
    toolMessageIdsRef,
    clickPaintCacheRef,
    enqueueMessageUpdate,
    flushMessageUpdates,
    append,
    upsertToolMessage,
    finalizeThinkingDurations,
    toggleThinkingById,
    toggleToolById,
    toggleLastCollapsible,
    toggleLastToolGroup
  };
}
