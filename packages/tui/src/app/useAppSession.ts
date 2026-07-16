import { useCallback, useEffect, useRef, useState } from 'react';

import {
  t,
  type AgentRuntime,
  type HybridSessionStore,
  type PendingToolApproval,
  type SessionSummary
} from '@kross/core';

import type { ChatMessage } from '../ui';
import {
  formatSessionError,
  fromStoredSessionMessage,
  safeListRecentSessions,
  toStoredSessionMessage
} from './sessionMessages';

export interface UseAppSessionOptions {
  sessionStore: Pick<
    HybridSessionStore,
    | 'createSession'
    | 'listRecent'
    | 'loadSession'
    | 'upsertMessage'
    | 'syncMessages'
    | 'upsertContextState'
    | 'upsertWorkState'
  > | undefined;
  sessionStoreError?: string;
  cwd: string;
  onExitRequest?: () => void;
  agentRuntime: AgentRuntime;
  latestMessagesRef: React.MutableRefObject<ChatMessage[]>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  nextMessageIdRef: React.MutableRefObject<number>;
  toolMessageIdsRef: React.MutableRefObject<Map<string, number>>;
  queueRef: React.MutableRefObject<string[]>;
  setQueueLength: React.Dispatch<React.SetStateAction<number>>;
  processingRef: React.MutableRefObject<boolean>;
  pendingToolApproval: PendingToolApproval | undefined;
  setPendingToolApproval: React.Dispatch<
    React.SetStateAction<PendingToolApproval | undefined>
  >;
  setPendingConductorPlan: React.Dispatch<
    React.SetStateAction<{ prompt: string; mode: import('@kross/core').AgentMode } | undefined>
  >;
  setMode: React.Dispatch<React.SetStateAction<import('@kross/core').AgentMode>>;
  setAwaitingReply: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingMessageId: React.Dispatch<React.SetStateAction<number | undefined>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  messages: ChatMessage[];
  flushMessageUpdates: () => void;
  append: (
    from: ChatMessage['from'],
    text: string,
    options?: { expanded?: boolean }
  ) => number;
  resetToBottom: () => void;
}

export function useAppSession({
  sessionStore,
  sessionStoreError,
  cwd,
  onExitRequest,
  agentRuntime,
  latestMessagesRef,
  setMessages,
  nextMessageIdRef,
  toolMessageIdsRef,
  queueRef,
  setQueueLength,
  processingRef,
  pendingToolApproval,
  setPendingToolApproval,
  setPendingConductorPlan,
  setMode,
  setAwaitingReply,
  setStreamingMessageId,
  setStatus,
  messages,
  flushMessageUpdates,
  append,
  resetToBottom
}: UseAppSessionOptions) {
  const [sessionNotice, setSessionNotice] = useState<string | undefined>(
    sessionStoreError
  );
  const [recentSessions, setRecentSessions] = useState<SessionSummary[]>(() =>
    safeListRecentSessions(sessionStore, cwd)
  );
  const [selectedRecentSession, setSelectedRecentSession] = useState<
    number | undefined
  >();
  const activeSessionIdRef = useRef<string | undefined>();
  const sessionSyncTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();

  const refreshRecentSessions = useCallback(() => {
    if (!sessionStore) {
      setRecentSessions([]);
      return;
    }
    try {
      setRecentSessions(sessionStore.listRecent(cwd, 4));
    } catch (error) {
      setSessionNotice(formatSessionError('session.readFailed', error));
    }
  }, [cwd, sessionStore]);

  useEffect(() => {
    refreshRecentSessions();
  }, [refreshRecentSessions]);

  useEffect(() => {
    if (sessionStoreError) {
      setSessionNotice(sessionStoreError);
    }
  }, [sessionStoreError]);

  useEffect(() => {
    setSelectedRecentSession((current) => {
      if (current === undefined || recentSessions.length === 0) {
        return undefined;
      }
      return Math.min(current, recentSessions.length - 1);
    });
  }, [recentSessions.length]);

  const ensureActiveSession = useCallback((): string | undefined => {
    if (activeSessionIdRef.current || !sessionStore) {
      return activeSessionIdRef.current;
    }
    try {
      const created = sessionStore.createSession(cwd);
      activeSessionIdRef.current = created.id;
      setRecentSessions((current) => [
        created,
        ...current.filter((session) => session.id !== created.id)
      ].slice(0, 4));
      setSelectedRecentSession(undefined);
      setSessionNotice(undefined);
      return created.id;
    } catch (error) {
      setSessionNotice(formatSessionError('session.createFailed', error));
      return undefined;
    }
  }, [cwd, sessionStore]);

  const persistMessage = useCallback((message: ChatMessage) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionStore || !sessionId) {
      return;
    }
    try {
      sessionStore.upsertMessage(sessionId, toStoredSessionMessage(message));
    } catch (error) {
      setSessionNotice(formatSessionError('session.saveFailed', error));
    }
  }, [sessionStore]);

  const syncVisibleMessages = useCallback((
    reportError = true,
    options?: { sessionId?: string; messages?: ChatMessage[] }
  ) => {
    const sessionId = options?.sessionId ?? activeSessionIdRef.current;
    if (!sessionStore || !sessionId) {
      return;
    }
    const messagesToSync = options?.messages ?? latestMessagesRef.current;
    try {
      sessionStore.syncMessages(
        sessionId,
        messagesToSync.map(toStoredSessionMessage)
      );
      sessionStore.upsertContextState(
        sessionId,
        agentRuntime.exportContextState(),
        Math.max(
          0,
          ...messagesToSync
            .filter(
              (message) => message.from === 'user' || message.from === 'agent'
            )
            .map((message) => message.id)
        )
      );
      sessionStore.upsertWorkState(sessionId, agentRuntime.exportWorkState());
    } catch (error) {
      if (reportError) {
        setSessionNotice(formatSessionError('session.syncFailed', error));
      }
    }
  }, [agentRuntime, latestMessagesRef, sessionStore]);

  const cancelSessionSyncTimer = useCallback(() => {
    if (sessionSyncTimerRef.current) {
      clearTimeout(sessionSyncTimerRef.current);
      sessionSyncTimerRef.current = undefined;
    }
  }, []);

  const flushSession = useCallback(() => {
    // 先把尚未进入 React state 的流式增量合并到 latestMessagesRef，再同步落盘。
    flushMessageUpdates();
    void agentRuntime.cancelPendingApprovals('process exit').catch(() => undefined);
    syncVisibleMessages(false);
  }, [agentRuntime, flushMessageUpdates, syncVisibleMessages]);

  const requestExit = useCallback(() => {
    // 退出前尽量取消挂起审批，避免后台 Task/工具继续跑
    void agentRuntime.cancelPendingApprovals('process exit').catch(() => undefined);
    flushSession();
    onExitRequest?.();
  }, [agentRuntime, flushSession, onExitRequest]);

  // 流式文本只在安静窗口后写一次最终快照，避免逐 token 膨胀 JSONL。
  useEffect(() => {
    if (!sessionStore || !activeSessionIdRef.current) {
      return;
    }
    if (sessionSyncTimerRef.current) {
      clearTimeout(sessionSyncTimerRef.current);
    }
    sessionSyncTimerRef.current = setTimeout(() => {
      sessionSyncTimerRef.current = undefined;
      syncVisibleMessages();
    }, 350);
    return () => {
      if (sessionSyncTimerRef.current) {
        clearTimeout(sessionSyncTimerRef.current);
        sessionSyncTimerRef.current = undefined;
      }
    };
  }, [messages, sessionStore, syncVisibleMessages]);

  useEffect(() => {
    return agentRuntime.onWorkStateChanged(() => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionStore || !sessionId) return;
      try {
        sessionStore.upsertWorkState(sessionId, agentRuntime.exportWorkState());
      } catch (error) {
        setSessionNotice(formatSessionError('session.saveFailed', error));
      }
    });
  }, [agentRuntime, sessionStore]);

  useEffect(() => {
    return () => {
      if (sessionSyncTimerRef.current) {
        clearTimeout(sessionSyncTimerRef.current);
      }
      syncVisibleMessages(false);
    };
  }, [syncVisibleMessages]);

  /**
   * 切换会话前：取消 debounce，并把当前会话以「旧 sessionId + 当前消息快照」落盘。
   * 避免 activeSessionIdRef 已切到新会话时，旧定时器把旧消息 upsert 进新会话。
   */
  const flushCurrentSessionBeforeSwitch = useCallback(() => {
    cancelSessionSyncTimer();
    flushMessageUpdates();
    const previousSessionId = activeSessionIdRef.current;
    if (!previousSessionId) {
      return;
    }
    syncVisibleMessages(false, {
      sessionId: previousSessionId,
      messages: latestMessagesRef.current
    });
  }, [cancelSessionSyncTimer, flushMessageUpdates, latestMessagesRef, syncVisibleMessages]);

  /**
   * 无 sessionId 的 `/resume`：进入首页会话选择，而不是直接恢复最近一条。
   */
  const openSessionPicker = useCallback((): boolean => {
    if (!sessionStore) {
      setSessionNotice(t('session.disabled'));
      return false;
    }
    if (processingRef.current || pendingToolApproval) {
      const message = t('session.busy');
      setSessionNotice(message);
      if (latestMessagesRef.current.some((item) => item.from === 'user')) {
        append('system', message);
      }
      return false;
    }

    flushCurrentSessionBeforeSwitch();
    activeSessionIdRef.current = undefined;
    nextMessageIdRef.current = 1;
    toolMessageIdsRef.current.clear();
    queueRef.current.length = 0;
    setQueueLength(0);
    setPendingToolApproval(undefined);
    setPendingConductorPlan(undefined);
    setAwaitingReply(false);
    setStreamingMessageId(undefined);
    setStatus('ready');
    setMessages([]);
    // 清空模型上下文与陈旧 usage，避免首页顶栏仍显示上一会话占用。
    agentRuntime.restoreConversation([]);
    agentRuntime.restoreWorkState({ version: 1, todos: [], sessionMode: 'auto' });
    setMode('auto');

    let sessions: SessionSummary[] = [];
    try {
      sessions = sessionStore.listRecent(cwd, 4);
      setRecentSessions(sessions);
    } catch (error) {
      setSessionNotice(formatSessionError('session.readFailed', error));
      setSelectedRecentSession(undefined);
      return false;
    }

    if (sessions.length === 0) {
      setSelectedRecentSession(undefined);
      setSessionNotice(t('session.empty'));
      return false;
    }

    // 预选第一条，用户仍可用 ↑↓ 改选，Enter 恢复。
    setSelectedRecentSession(0);
    setSessionNotice(undefined);
    resetToBottom();
    return true;
  }, [
    agentRuntime,
    append,
    cwd,
    flushCurrentSessionBeforeSwitch,
    latestMessagesRef,
    nextMessageIdRef,
    pendingToolApproval,
    processingRef,
    queueRef,
    resetToBottom,
    sessionStore,
    setAwaitingReply,
    setMessages,
    setMode,
    setPendingConductorPlan,
    setPendingToolApproval,
    setQueueLength,
    setStatus,
    setStreamingMessageId,
    toolMessageIdsRef
  ]);

  const resumeSession = useCallback(async (
    selector?: string
  ): Promise<boolean> => {
    const selectedSessionId =
      selectedRecentSession === undefined
        ? undefined
        : recentSessions[selectedRecentSession]?.id;
    const target = selector?.trim() || selectedSessionId;
    if (!sessionStore) {
      setSessionNotice(t('session.disabled'));
      return false;
    }
    if (!target) {
      // 无目标时打开选择器，而不是误报「没有历史」或静默取最近一条。
      return openSessionPicker();
    }
    if (processingRef.current || pendingToolApproval) {
      const message = t('session.busy');
      setSessionNotice(message);
      if (latestMessagesRef.current.some((item) => item.from === 'user')) {
        append('system', message);
      }
      return false;
    }

    try {
      flushCurrentSessionBeforeSwitch();
      const restored = sessionStore.loadSession(cwd, target);
      if (!restored) {
        const message = t('session.notFound', { target });
        setSessionNotice(message);
        if (latestMessagesRef.current.some((item) => item.from === 'user')) {
          append('system', message);
        }
        return false;
      }

      const restoredMessages = restored.messages.map(fromStoredSessionMessage);
      // 先锁定目标 sessionId，再 setMessages，防止 debounce 用错目标。
      activeSessionIdRef.current = restored.summary.id;
      nextMessageIdRef.current =
        Math.max(0, ...restoredMessages.map((message) => message.id)) + 1;
      toolMessageIdsRef.current.clear();
      queueRef.current.length = 0;
      setQueueLength(0);
      setPendingToolApproval(undefined);
      setPendingConductorPlan(undefined);
      setAwaitingReply(false);
      setStreamingMessageId(undefined);
      setStatus('ready');
      setMessages(restoredMessages);
      const conversation: Array<{
        role: 'user' | 'assistant';
        content: string;
      }> = [];
      for (const message of restoredMessages) {
        if (message.from === 'user') {
          conversation.push({
            role: 'user',
            content: message.text.replace(/^>\s*/, '')
          });
        } else if (message.from === 'agent') {
          conversation.push({ role: 'assistant', content: message.text });
        }
      }
      const restoredContext = restored.contextState
        ? agentRuntime.restoreContextState(restored.contextState)
        : false;
      const restoredInterruptedTurn =
        restoredContext && restored.contextState?.thread.openTurnId !== undefined;
      const maintenance = restoredContext
        ? undefined
        : agentRuntime.restoreConversation(conversation);
      const workState = restored.workState ?? {
        version: 1 as const,
        todos: [],
        sessionMode: 'auto' as const
      };
      agentRuntime.restoreWorkState(workState);
      setMode(workState.sessionMode);
      const pending = agentRuntime.getPendingModeExecution();
      setPendingConductorPlan(
        pending ? { prompt: pending.goal, mode: pending.mode } : undefined
      );
      setRecentSessions((current) => [
        restored.summary,
        ...current.filter((session) => session.id !== restored.summary.id)
      ].slice(0, 4));
      setSelectedRecentSession(undefined);
      setSessionNotice(undefined);
      if (
        maintenance &&
        (maintenance.droppedMessageCount > 0 || maintenance.compacted)
      ) {
        const notice = maintenance.compacted
          ? t('context.restoredTruncated', {
              kept: maintenance.preservedMessageCount,
              dropped: maintenance.droppedMessageCount
            })
          : t('context.restoredHardTrim', {
              kept: maintenance.preservedMessageCount,
              dropped: maintenance.droppedMessageCount
            });
        // UI-only system line; model history already holds the summary.
        setMessages((current) => [
          ...current,
          {
            id: nextMessageIdRef.current++,
            from: 'system',
            text: notice,
            createdAt: new Date().toISOString()
          }
        ]);
      }
      if (restoredInterruptedTurn) {
        setMessages((current) => [
          ...current,
          {
            id: nextMessageIdRef.current++,
            from: 'system',
            text: t('context.restoredInterrupted'),
            createdAt: new Date().toISOString()
          }
        ]);
      }
      resetToBottom();
      return true;
    } catch (error) {
      const message = formatSessionError('session.resumeFailed', error);
      setSessionNotice(message);
      if (latestMessagesRef.current.some((item) => item.from === 'user')) {
        append('system', message);
      }
      return false;
    }
  }, [
    agentRuntime,
    append,
    cwd,
    flushCurrentSessionBeforeSwitch,
    latestMessagesRef,
    nextMessageIdRef,
    openSessionPicker,
    pendingToolApproval,
    processingRef,
    queueRef,
    recentSessions,
    resetToBottom,
    selectedRecentSession,
    sessionStore,
    setAwaitingReply,
    setMessages,
    setMode,
    setPendingConductorPlan,
    setPendingToolApproval,
    setQueueLength,
    setStatus,
    setStreamingMessageId,
    toolMessageIdsRef
  ]);

  return {
    sessionNotice,
    recentSessions,
    selectedRecentSession,
    setSelectedRecentSession,
    ensureActiveSession,
    persistMessage,
    flushSession,
    requestExit,
    openSessionPicker,
    resumeSession
  };
}
