import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useInput } from 'ink';

import {
  AgentRuntime,
  getLlmProviderDefinition,
  loadKrossConfig,
  nextPermissionMode,
  ObservableTraceStore,
  t,
  updateKrossLlmConfig,
  type AgentMode,
  type AgentResult,
  type ConfigImportController,
  type ConfigImportPrompt,
  type HybridSessionStore,
  type MessageKey,
  type PendingToolApproval,
  type PermissionMode,
  type SessionSummary,
  type StoredSessionMessage,
  type TraceEvent,
  type TraceStore
} from '@kross/core';

import {
  ApprovalPanel,
  applyModelSettings,
  COMPOSER_FOOTER_HEIGHT,
  Composer,
  createModelSettingsState,
  defaultApprovalSelection,
  buildToolState,
  ensureToolItems,
  getSlashCommandSuggestions,
  formatCwdLabel,
  formatToolTitle,
  HeaderBar,
  isAggregatableTool,
  MessageViewport,
  ModelSettingsPanel,
  moveSettingsSelection,
  SlashSuggest,
  resolveSlashSuggestHeight,
  resolveApprovalPanelHeight,
  switchSettingsSection,
  ThinkingIndicator,
  WelcomeHome,
  useTerminalSize,
  type ChatMessage,
  type ModelSettingsState,
  type ToolCallState
} from './ui';
import {
  hitTestClickableMessage,
  MessagePaintCache,
  resolveViewportContentRows
} from './ui/messagePaint';
import {
  mergeToolItem,
  toToolItem
} from './ui/toolDisplay';
import { useMouseScroll } from './ui/useMouseScroll';
import {
  stripMouseArtifactsFromInput,
  subscribeClick
} from './terminal/mouseTracking';
import {
  AppShell,
  resolveMessageViewportHeight
} from './app/AppShell';
import { formatImportPrompt, handleCommand } from './app/appCommands';
import {
  appendApprovalResult,
  handleTraceEvent
} from './app/traceMessages';
import { useViewportScroll } from './app/useViewportScroll';
import {
  createMessageUpdateBuffer,
  type MessageUpdateBuffer
} from './app/messageUpdateBuffer';

export interface AppProps {
  runtime?: AgentRuntime;
  createRuntime?: () => AgentRuntime;
  configImportController?: ConfigImportController;
  initialMode?: AgentMode;
  projectName?: string;
  onReady?: (api: AppTestApi) => void;
  /**
   * 全屏应用壳：固定顶栏/底栏，中间消息视口裁剪滚动。
   * 无 TTY 尺寸（测试环境）时自动退化为文档流布局。
   */
  fullscreen?: boolean;
  /** 欢迎页展示用；默认 process.cwd() */
  cwd?: string;
  branch?: string;
  version?: string;
  /** 会话存储初始化失败时由启动入口传入，避免静默降级。 */
  sessionStoreError?: string;
  /** 由启动入口统一执行 flush → unmount → close。 */
  onExitRequest?: () => void;
  /** 可选的持久化会话服务；测试/嵌入场景不传时保持纯内存行为。 */
  sessionStore?: Pick<
    HybridSessionStore,
    | 'createSession'
    | 'listRecent'
    | 'loadSession'
    | 'upsertMessage'
    | 'syncMessages'
  >;
}

export interface AppTestApi {
  submit: (value: string) => Promise<void>;
  choosePlanApproval: (approved: boolean) => Promise<void>;
  chooseToolApproval: (approved: boolean) => Promise<void>;
  setInput: (value: string) => void;
  toggleCollapse: () => void;
  toggleToolGroup: () => void;
  resumeSession: (selector?: string) => Promise<boolean>;
  flushSession: () => void;
  requestExit: () => void;
  setRecentSessionSelection: (index: number | undefined) => void;
}

export function App({
  runtime,
  createRuntime,
  configImportController,
  initialMode = 'auto',
  projectName = 'local',
  onReady,
  fullscreen = false,
  cwd = process.cwd(),
  branch,
  version = '0.1.0',
  sessionStore,
  sessionStoreError,
  onExitRequest
}: AppProps) {
  const { columns, rows, isTty } = useTerminalSize();
  const shellMode = fullscreen && isTty;
  const cwdLabel = useMemo(() => formatCwdLabel(cwd), [cwd]);
  const initialImportPrompt = useMemo(
    () => configImportController?.getPrompt(),
    [configImportController]
  );
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  /** Bumped by /lang so chrome re-reads t() for the new locale. */
  const [localeGeneration, setLocaleGeneration] = useState(0);
  // 运行时创建可能因环境变量/配置不完整而抛错（例如只配了 AGENT_LLM_PROVIDER
  // 却缺少 key/model），这里兜底回退到未配置模型的本地 runtime，避免 TUI 启动即崩溃。
  const { runtime: agentRuntime, error: runtimeError } = useMemo(() => {
    try {
      return {
        runtime: runtime ?? createRuntime?.() ?? createMemoryRuntime(),
        error: undefined
      };
    } catch (error) {
      return {
        runtime: createMemoryRuntime(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }, [createRuntime, runtime, runtimeGeneration]);
  const [importPrompt, setImportPrompt] = useState<ConfigImportPrompt | undefined>(
    initialImportPrompt
  );
  const [mode, setMode] = useState<AgentMode>(initialMode);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() =>
    agentRuntime.getPermissionMode()
  );
  // 不 memo：/model 会就地 setModel/setLlmClient，依赖 agentRuntime 引用不变，
  // 需在 append 触发的重渲染中重新读取，否则底栏一直显示旧模型。
  const modelLabel = agentRuntime.getModelLabel();
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('ready');
  const [queueLength, setQueueLength] = useState(0);
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | undefined>();
  const [pendingCrossRepoPlan, setPendingCrossRepoPlan] = useState<{
    prompt: string;
    mode: AgentMode;
  } | undefined>();
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [loadingVariant, setLoadingVariant] = useState<'thinking' | 'tool'>('thinking');
  const [streamingMessageId, setStreamingMessageId] = useState<number | undefined>();
  const [approvalSelection, setApprovalSelection] = useState<'approve' | 'reject'>('approve');
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [modelSettings, setModelSettings] = useState<ModelSettingsState | undefined>();
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
  const modelSettingsOpen = modelSettings !== undefined;
  const {
    scrollOffset,
    scrollBy,
    resetToBottom,
    handleScrollBounds
  } = useViewportScroll();
  // 新会话不预置 agent 欢迎气泡；首页用 WelcomeHome，首条用户消息后进入对话流
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    initialImportPrompt
      ? [
          {
            id: 1,
            from: 'system' as const,
            text: formatImportPrompt(initialImportPrompt)
          }
        ]
      : []
  );
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
    } catch (error) {
      if (reportError) {
        setSessionNotice(formatSessionError('session.syncFailed', error));
      }
    }
  }, [sessionStore]);

  const cancelSessionSyncTimer = useCallback(() => {
    if (sessionSyncTimerRef.current) {
      clearTimeout(sessionSyncTimerRef.current);
      sessionSyncTimerRef.current = undefined;
    }
  }, []);

  const flushSession = useCallback(() => {
    // 先把尚未进入 React state 的流式增量合并到 latestMessagesRef，再同步落盘。
    flushMessageUpdates();
    syncVisibleMessages(false);
  }, [flushMessageUpdates, syncVisibleMessages]);

  const requestExit = useCallback(() => {
    flushSession();
    onExitRequest?.();
  }, [flushSession, onExitRequest]);

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
    return () => {
      if (sessionSyncTimerRef.current) {
        clearTimeout(sessionSyncTimerRef.current);
      }
      syncVisibleMessages(false);
    };
  }, [syncVisibleMessages]);

  const contextUsage = useMemo(
    () =>
      agentRuntime.getContextUsage({
        requestedMode: mode,
        currentUserInput: input,
        env: process.env
      }),
    // messages / 工具结果变化后需要刷新占用
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用长度与 generation 触发重算
    [agentRuntime, mode, input, messages.length, runtimeGeneration, streamingMessageId]
  );
  const nextMessageIdRef = useRef(initialImportPrompt ? 2 : 1);
  const processingRef = useRef(false);
  const queueRef = useRef<string[]>([]);
  /** tool call 关联键 → 消息 id，用于 in-place 更新卡片状态 */
  const toolMessageIdsRef = useRef(new Map<string, number>());

  useEffect(() => {
    setPermissionMode(agentRuntime.getPermissionMode());
  }, [agentRuntime]);

  const slashSuggestionResult = useMemo(
    () =>
      getSlashCommandSuggestions(input, {
        hasPendingCrossRepoPlan: pendingCrossRepoPlan !== undefined
      }),
    // localeGeneration: re-resolve descriptions after /lang
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
    [input, pendingCrossRepoPlan, localeGeneration]
  );
  const slashSuggestions = slashSuggestionResult.commands;

  useEffect(() => {
    setSlashSelectedIndex(0);
  }, [input]);

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
  }, [cancelSessionSyncTimer, flushMessageUpdates, syncVisibleMessages]);

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
    setPendingCrossRepoPlan(undefined);
    setAwaitingReply(false);
    setStreamingMessageId(undefined);
    setStatus('ready');
    setMessages([]);
    // 清空模型上下文与陈旧 usage，避免首页顶栏仍显示上一会话占用。
    agentRuntime.restoreConversation([]);

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
    pendingToolApproval,
    resetToBottom,
    sessionStore
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
      setPendingCrossRepoPlan(undefined);
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
      const maintenance = agentRuntime.restoreConversation(conversation);
      setRecentSessions((current) => [
        restored.summary,
        ...current.filter((session) => session.id !== restored.summary.id)
      ].slice(0, 4));
      setSelectedRecentSession(undefined);
      setSessionNotice(undefined);
      if (
        maintenance.droppedMessageCount > 0 ||
        maintenance.compacted
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
    openSessionPicker,
    pendingToolApproval,
    recentSessions,
    resetToBottom,
    selectedRecentSession,
    sessionStore
  ]);

  const cyclePermissionMode = useCallback(() => {
    const next = nextPermissionMode(permissionMode);
    agentRuntime.setPermissionMode(next);
    setPermissionMode(next);
    // 页脚/header 已展示当前权限，不再往会话刷 system 提示
  }, [agentRuntime, permissionMode]);

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

  const clickPaintCacheRef = useRef(new MessagePaintCache());

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

  useEffect(() => {
    return agentRuntime.onTrace((event) => {
      handleTraceEvent(event, {
        upsertToolMessage,
        setLoadingVariant,
        setAwaitingReply,
        setStreamingMessageId
      });
    });
  }, [agentRuntime, upsertToolMessage]);

  const runTurn = useCallback(async (
    prompt: string,
    options: { planApproved?: boolean; requestedMode?: AgentMode } = {}
  ) => {
    setStatus('responding');
    setAwaitingReply(true);
    setLoadingVariant('thinking');
    setStreamingMessageId(undefined);
    // 新 run 清空工具卡片索引，避免跨 run 串卡
    toolMessageIdsRef.current.clear();

    let streamedMessageId: number | undefined;
    let thinkingMessageId: number | undefined;
    let streamedText = '';
    let thinkingText = '';
    let sawAgentText = false;
    let result: AgentResult | undefined;

    const beginTurn = () => {
      flushMessageUpdates();
      finalizeThinkingDurations();
      // 每轮 LLM 迭代新开气泡，避免 tool 后的 thinking/text 写回工具前消息
      streamedMessageId = undefined;
      thinkingMessageId = undefined;
      streamedText = '';
      thinkingText = '';
      setStreamingMessageId(undefined);
    };

    try {
      for await (const event of agentRuntime.runStreaming({
        input: prompt,
        requestedMode: options.requestedMode ?? mode,
        approvals: { plan: options.planApproved === true }
      })) {
        if (event.type === 'turn-start') {
          beginTurn();
          setAwaitingReply(true);
          setLoadingVariant('thinking');
          continue;
        }

        if (event.type === 'tools-start') {
          flushMessageUpdates();
          setStreamingMessageId(undefined);
          setAwaitingReply(true);
          setLoadingVariant('tool');
          continue;
        }

        if (event.type === 'thinking-delta') {
          thinkingText += event.text;
          setAwaitingReply(false);
          setLoadingVariant('thinking');
          if (thinkingMessageId === undefined) {
            thinkingMessageId = append('thinking', thinkingText);
            setStreamingMessageId(thinkingMessageId);
          } else {
            enqueueMessageUpdate(thinkingMessageId, thinkingText);
          }
          continue;
        }

        if (event.type === 'text-delta') {
          streamedText += event.text;
          sawAgentText = true;
          setAwaitingReply(false);
          if (streamedMessageId === undefined) {
            streamedMessageId = append('agent', streamedText);
            setStreamingMessageId(streamedMessageId);
          } else {
            enqueueMessageUpdate(streamedMessageId, streamedText);
          }
          continue;
        }

        flushMessageUpdates();
        result = event.result;
        setAwaitingReply(false);
        setStreamingMessageId(undefined);
        finalizeThinkingDurations();
      }
    } catch (error) {
      flushMessageUpdates();
      finalizeThinkingDurations();
      append(
        'system',
        t('app.runError', {
          error: error instanceof Error ? error.message : String(error)
        })
      );
      setStatus('ready');
      setAwaitingReply(false);
      setStreamingMessageId(undefined);
      return;
    }

    if (!result) {
      flushMessageUpdates();
      finalizeThinkingDurations();
      setStatus('ready');
      setStreamingMessageId(undefined);
      return;
    }

    if (result.mode === 'cross-repo' && result.status === 'cancelled') {
      setStatus('waiting-approval');
      setPendingCrossRepoPlan({ prompt, mode: options.requestedMode ?? mode });
      append('system', t('app.crossRepoPaused'));
      return;
    }

    if (result.status === 'approval-required' && result.pendingApproval) {
      setStatus('approval-required');
      setPendingToolApproval(result.pendingApproval);
      setApprovalSelection(defaultApprovalSelection(result.pendingApproval.risk));
      append('system', result.summary);
      finalizeThinkingDurations();
      return;
    }

    // 已按 turn 流式写入气泡时，不要用跨轮拼接的 fullText 覆盖最后一条
    if (!sawAgentText && result.summary.trim().length > 0) {
      append('agent', result.summary);
    }
    finalizeThinkingDurations();
    setStatus('ready');
  }, [
    agentRuntime,
    append,
    enqueueMessageUpdate,
    finalizeThinkingDurations,
    flushMessageUpdates,
    mode
  ]);

  const chooseToolApproval = useCallback(async (approved: boolean) => {
    if (!pendingToolApproval) {
      return;
    }

    setStatus('responding');
    setAwaitingReply(true);
    setLoadingVariant('tool');
    setStreamingMessageId(undefined);
    setPendingToolApproval(undefined);
    append(
      'system',
      approved
        ? t('app.toolApproved', { tool: pendingToolApproval.toolName })
        : t('app.toolRejected', { tool: pendingToolApproval.toolName })
    );

    // 与首轮 runTurn 相同：审批后续也走 stream，避免 complete() 整包倾倒。
    // （shift+tab 改权限与是否流式无关；旧路径 resolveToolApproval 固定非流式。）
    let streamedMessageId: number | undefined;
    let thinkingMessageId: number | undefined;
    let streamedText = '';
    let thinkingText = '';
    let sawAgentText = false;
    let result: AgentResult | undefined;

    const beginTurn = () => {
      flushMessageUpdates();
      streamedMessageId = undefined;
      thinkingMessageId = undefined;
      streamedText = '';
      thinkingText = '';
      setStreamingMessageId(undefined);
    };

    try {
      for await (const event of agentRuntime.resolveToolApprovalStreaming({
        runId: pendingToolApproval.runId,
        approved
      })) {
        if (event.type === 'turn-start') {
          beginTurn();
          setAwaitingReply(true);
          setLoadingVariant('thinking');
          continue;
        }

        if (event.type === 'tools-start') {
          flushMessageUpdates();
          setStreamingMessageId(undefined);
          setAwaitingReply(true);
          setLoadingVariant('tool');
          continue;
        }

        if (event.type === 'thinking-delta') {
          thinkingText += event.text;
          setAwaitingReply(false);
          setLoadingVariant('thinking');
          if (thinkingMessageId === undefined) {
            thinkingMessageId = append('thinking', thinkingText);
            setStreamingMessageId(thinkingMessageId);
          } else {
            enqueueMessageUpdate(thinkingMessageId, thinkingText);
          }
          continue;
        }

        if (event.type === 'text-delta') {
          streamedText += event.text;
          sawAgentText = true;
          setAwaitingReply(false);
          if (streamedMessageId === undefined) {
            streamedMessageId = append('agent', streamedText);
            setStreamingMessageId(streamedMessageId);
          } else {
            enqueueMessageUpdate(streamedMessageId, streamedText);
          }
          continue;
        }

        flushMessageUpdates();
        result = event.result;
        setAwaitingReply(false);
        setStreamingMessageId(undefined);
      }
    } catch (error) {
      flushMessageUpdates();
      append(
        'system',
        t('app.approvalError', {
          error: error instanceof Error ? error.message : String(error)
        })
      );
      setStatus('ready');
      setAwaitingReply(false);
      setStreamingMessageId(undefined);
      return;
    }

    if (!result) {
      flushMessageUpdates();
      setStatus('ready');
      setStreamingMessageId(undefined);
      return;
    }

    // 模型可能在同一轮里继续请求其他高风险工具，需要再次进入审批。
    if (result.status === 'approval-required' && result.pendingApproval) {
      setStatus('approval-required');
      setAwaitingReply(false);
      setPendingToolApproval(result.pendingApproval);
      setApprovalSelection(defaultApprovalSelection(result.pendingApproval.risk));
      append('system', result.summary);
      return;
    }

    // 已流式写入则勿再整包 append
    if (!sawAgentText) {
      appendApprovalResult(append, result);
    }
    setAwaitingReply(false);
    setStatus('ready');
  }, [
    agentRuntime,
    append,
    enqueueMessageUpdate,
    flushMessageUpdates,
    pendingToolApproval
  ]);

  const choosePlanApproval = useCallback(async (approved: boolean) => {
    if (!pendingCrossRepoPlan) {
      append('system', t('app.noCrossRepoPlan'));
      return;
    }

    const pending = pendingCrossRepoPlan;
    setPendingCrossRepoPlan(undefined);

    if (!approved) {
      setStatus('ready');
      append('system', t('app.crossRepoCancelled'));
      return;
    }

    append('system', t('app.crossRepoConfirmed'));
    processingRef.current = true;
    try {
      await runTurn(pending.prompt, {
        planApproved: true,
        requestedMode: pending.mode
      });
    } finally {
      processingRef.current = false;
    }
  }, [append, pendingCrossRepoPlan, runTurn]);

  // 鼠标滚轮 / Mac 触摸板（需终端 mouse tracking，全屏启动时已开启）
  // useMouseScroll 内部已 rAF 合并；这里 steps 即本帧累计行数，不再 *3 放大抖动
  useMouseScroll(
    (direction, steps) => {
      if (pendingToolApproval || modelSettingsOpen) {
        return;
      }
      const step = Math.max(1, steps);
      // up = 看更早消息（增大 offset）；down = 回底部方向
      scrollBy(direction === 'up' ? step : -step);
    },
    shellMode
  );

  const openModelSettings = useCallback(() => {
    setModelSettings(
      createModelSettingsState(agentRuntime, process.env, loadKrossConfig()?.llm)
    );
  }, [agentRuntime]);

  const closeModelSettings = useCallback(() => {
    setModelSettings(undefined);
  }, []);

  const confirmModelSettings = useCallback(() => {
    if (!modelSettings) {
      return;
    }
    const result = applyModelSettings(
      agentRuntime,
      modelSettings,
      process.env,
      loadKrossConfig()?.llm
    );
    if (!result.ok) {
      append('system', result.message);
      return;
    }

    const client = agentRuntime.getLlmClient();
    if (client?.model) {
      try {
        const def = getLlmProviderDefinition(client.provider);
        const env = process.env;
        const apiKey = def.apiKeyEnv
          .map((key) => env[key]?.trim())
          .find(Boolean);
        const authToken = def.authTokenEnv
          ?.map((key) => env[key]?.trim())
          .find(Boolean);
        const baseUrl = def.baseUrlEnv
          ? env[def.baseUrlEnv]?.trim()
          : undefined;
        updateKrossLlmConfig({
          provider: client.provider,
          model: client.model,
          ...(apiKey ? { apiKey } : {}),
          ...(client.provider === 'anthropic' && authToken
            ? { authToken }
            : {}),
          ...(baseUrl ? { baseUrl } : {}),
          thinkingEffort: agentRuntime.getThinkingEffort()
        });
      } catch {
        // best-effort — refuse-to-wipe is intentional
      }
    }

    append('system', result.summary);
    setModelSettings(undefined);
  }, [agentRuntime, append, modelSettings]);

  const hasUserActivity = messages.some((message) => message.from === 'user');
  const appError = runtimeError
    ? t('app.runtimeFallback', { error: runtimeError })
    : sessionNotice;
  const isHome =
    !hasUserActivity &&
    status === 'ready' &&
    !pendingToolApproval &&
    !modelSettingsOpen;

  useInput((inputKey, key) => {
    if (key.ctrl && inputKey.toLowerCase() === 'c') {
      requestExit();
      return;
    }

    // ctrl+p：打开/关闭模型与思考强度面板
    if (key.ctrl && inputKey.toLowerCase() === 'p') {
      if (pendingToolApproval) {
        return;
      }
      if (modelSettingsOpen) {
        closeModelSettings();
      } else {
        openModelSettings();
      }
      return;
    }

    // 模型设置面板优先接管导航键
    if (modelSettings) {
      if (key.escape) {
        closeModelSettings();
        return;
      }
      if (key.leftArrow) {
        setModelSettings((current) =>
          current ? switchSettingsSection(current, 'effort') : current
        );
        return;
      }
      if (key.rightArrow) {
        setModelSettings((current) =>
          current ? switchSettingsSection(current, 'model') : current
        );
        return;
      }
      if (key.upArrow) {
        setModelSettings((current) =>
          current ? moveSettingsSelection(current, 'up') : current
        );
        return;
      }
      if (key.downArrow) {
        setModelSettings((current) =>
          current ? moveSettingsSelection(current, 'down') : current
        );
        return;
      }
      if (key.return) {
        confirmModelSettings();
        return;
      }
      // 面板打开时吞掉其它输入，避免落到 Composer
      return;
    }

    // ctrl+o：切换最近一条 thinking 的折叠/展开（审批中也可用）
    if (key.ctrl && inputKey.toLowerCase() === 'o') {
      toggleLastCollapsible();
      return;
    }

    // ctrl+e：展开/折叠最近一条工具组（如 Read 5 files 明细）
    if (key.ctrl && inputKey.toLowerCase() === 'e') {
      toggleLastToolGroup();
      return;
    }

    // 最近会话一旦选中，Esc 始终优先取消；即使用户已经开始输入也不例外。
    if (isHome && key.escape && selectedRecentSession !== undefined) {
      setSelectedRecentSession(undefined);
      return;
    }

    // 首页输入为空时，方向键只切换最近会话；Enter 仍交给 Composer 提交恢复。
    if (isHome && input.trim().length === 0 && recentSessions.length > 0) {
      if (key.upArrow) {
        setSelectedRecentSession((current) =>
          current === undefined || current <= 0
            ? recentSessions.length - 1
            : current - 1
        );
        return;
      }
      if (key.downArrow) {
        setSelectedRecentSession((current) =>
          current === undefined || current >= recentSessions.length - 1
            ? 0
            : current + 1
        );
        return;
      }
    }

    // 消息视口滚动：PgUp/PgDn，或 ctrl+↑/↓（钳制在可滚动范围内）
    if (!pendingToolApproval) {
      const step = Math.max(3, Math.floor(rows / 4));
      if (key.pageUp || (key.ctrl && key.upArrow)) {
        scrollBy(step);
        return;
      }
      if (key.pageDown || (key.ctrl && key.downArrow)) {
        scrollBy(-step);
        return;
      }
    }

    if (key.shift && key.tab && !pendingToolApproval) {
      cyclePermissionMode();
      return;
    }

    if (pendingToolApproval) {
      if (key.leftArrow || key.rightArrow || inputKey.toLowerCase() === 'tab') {
        setApprovalSelection((current) => (current === 'approve' ? 'reject' : 'approve'));
        return;
      }
      if (inputKey.toLowerCase() === 'a') {
        void chooseToolApproval(true);
        return;
      }
      if (inputKey.toLowerCase() === 'r') {
        void chooseToolApproval(false);
        return;
      }
      if (key.return) {
        void chooseToolApproval(approvalSelection === 'approve');
      }
      return;
    }

    if (slashSuggestions.length === 0) {
      return;
    }

    if (key.escape) {
      setInput('');
      return;
    }

    if (key.upArrow) {
      setSlashSelectedIndex((current) =>
        current <= 0 ? slashSuggestions.length - 1 : current - 1
      );
      return;
    }

    if (key.downArrow) {
      setSlashSelectedIndex((current) =>
        current >= slashSuggestions.length - 1 ? 0 : current + 1
      );
      return;
    }

    if (key.tab) {
      const selected = slashSuggestions[slashSelectedIndex] ?? slashSuggestions[0];
      if (selected) {
        setInput(`${selected.name} `);
      }
      return;
    }
  });

  const submit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      if (isHome && selectedRecentSession !== undefined) {
        await resumeSession();
      }
      return;
    }

    // 打开设置面板（快捷入口，避免记一堆 /model /think 参数）
    if (trimmed === '/settings' || trimmed === '/model') {
      setInput('');
      openModelSettings();
      return;
    }

    // 斜杠提示打开时，若当前输入只是前缀，Enter 先补全选中命令。
    if (
      slashSuggestions.length > 0 &&
      !slashSuggestions.some((command) => command.name === trimmed || trimmed.startsWith(`${command.name} `))
    ) {
      const selected = slashSuggestions[slashSelectedIndex] ?? slashSuggestions[0];
      if (selected && trimmed !== selected.name) {
        setInput(`${selected.name} `);
        return;
      }
    }

    if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
      setInput('');
      const selector = trimmed.slice('/resume'.length).trim() || undefined;
      if (selector) {
        await resumeSession(selector);
      } else {
        // 无参：弹出会话选择，不直接恢复最近一条。
        openSessionPicker();
      }
      return;
    }

    setInput('');
    ensureActiveSession();
    append('user', `> ${trimmed}`);

    if (
      handleCommand(
        trimmed,
        append,
        setMode,
        setPermissionMode,
        agentRuntime,
        mode,
        importPrompt,
        configImportController,
        setImportPrompt,
        () => setRuntimeGeneration((current) => current + 1),
        toggleLastCollapsible,
        Boolean(pendingCrossRepoPlan),
        choosePlanApproval,
        () => setLocaleGeneration((current) => current + 1)
      )
    ) {
      return;
    }

    if (processingRef.current) {
      queueRef.current.push(trimmed);
      setQueueLength(queueRef.current.length);
      append('system', t('app.queued', { count: queueRef.current.length }));
      return;
    }

    processingRef.current = true;
    let next: string | undefined = trimmed;

    try {
      while (next) {
        await runTurn(next);
        next = queueRef.current.shift();
        setQueueLength(queueRef.current.length);
      }
    } finally {
      processingRef.current = false;
    }
  }, [
    agentRuntime,
    append,
    configImportController,
    importPrompt,
    mode,
    openModelSettings,
    runTurn,
    slashSelectedIndex,
    slashSuggestions,
    pendingCrossRepoPlan,
    choosePlanApproval,
    ensureActiveSession,
    isHome,
    openSessionPicker,
    recentSessions.length,
    resumeSession,
    selectedRecentSession,
    toggleLastCollapsible
  ]);

  useEffect(() => {
    onReady?.({
      submit,
      choosePlanApproval,
      chooseToolApproval,
      setInput,
      toggleCollapse: toggleLastCollapsible,
      toggleToolGroup: toggleLastToolGroup,
      resumeSession,
      flushSession,
      requestExit,
      setRecentSessionSelection: setSelectedRecentSession
    });
  }, [
    chooseToolApproval,
    choosePlanApproval,
    onReady,
    submit,
    resumeSession,
    flushSession,
    requestExit,
    toggleLastCollapsible,
    toggleLastToolGroup
  ]);

  const contentWidth = Math.max(40, columns - (shellMode ? 2 : 4));

  // 动态计算 footer 高度，防止 header + viewport + footer > rows 导致溢出
  const footerHeight = useMemo(() => {
    let h = 0;
    if (pendingToolApproval) {
      h += resolveApprovalPanelHeight(pendingToolApproval);
    } else if (modelSettings) {
      // title + tabs + rule + options + border + hint
      const optionRows =
        modelSettings.section === 'effort'
          ? modelSettings.efforts.length
          : Math.max(1, modelSettings.models.length);
      h += 7 + optionRows;
    } else {
      h += COMPOSER_FOOTER_HEIGHT;
    }
    if (status === 'responding' && awaitingReply) {
      h += 2; // ThinkingIndicator
    }
    if (
      !pendingToolApproval &&
      !modelSettingsOpen &&
      slashSuggestions.length > 0
    ) {
      h += resolveSlashSuggestHeight(
        slashSuggestions,
        slashSuggestionResult.hiddenCount
      );
    }
    return h;
  }, [
    pendingToolApproval,
    modelSettings,
    modelSettingsOpen,
    status,
    awaitingReply,
    slashSuggestions.length,
    slashSuggestionResult.hiddenCount
  ]);

  // Header: location line(1) + divider(1) = 2; + error(1) if present
  const headerHeight = appError ? 3 : 2;
  // paddingX 1 on each side doesn't affect height
  const messageViewportHeight = resolveMessageViewportHeight({
    rows,
    headerHeight,
    footerHeight
  });

  // 左键单击：命中 Thought / Tool 行才展开折叠（全屏坐标命中）
  useEffect(() => {
    return subscribeClick((event) => {
      if (pendingToolApproval || modelSettingsOpen || !shellMode) {
        return;
      }
      const { contentRows } = resolveViewportContentRows({
        messages,
        columns: contentWidth,
        viewportRows: messageViewportHeight,
        scrollOffset,
        streamingMessageId,
        paintCache: clickPaintCacheRef.current
      });
      const hit = hitTestClickableMessage({
        messages,
        columns: contentWidth,
        contentRows,
        scrollOffset,
        clickRow: event.row,
        viewportTopRow: headerHeight + 1,
        streamingMessageId,
        paintCache: clickPaintCacheRef.current
      });
      if (!hit) {
        return;
      }
      if (hit.kind === 'thinking') {
        toggleThinkingById(hit.messageId);
      } else {
        toggleToolById(hit.messageId);
      }
    });
  }, [
    pendingToolApproval,
    modelSettingsOpen,
    shellMode,
    headerHeight,
    contentWidth,
    messageViewportHeight,
    scrollOffset,
    messages,
    streamingMessageId,
    toggleThinkingById,
    toggleToolById
  ]);

  const header = (
    <HeaderBar
      projectName={projectName}
      branch={branch}
      cwdLabel={cwdLabel}
      mode={mode}
      status={status}
      queueLength={queueLength}
      permissionMode={permissionMode}
      runtimeError={appError}
      compact={isHome}
      contextUsageLabel={contextUsage.label}
      contextUsageRatio={contextUsage.ratio}
    />
  );

  const footer = (
    <Box flexDirection="column" flexShrink={0} width={contentWidth}>
      <ThinkingIndicator
        active={status === 'responding' && awaitingReply}
        variant={loadingVariant}
      />

      {pendingToolApproval ? (
        <ApprovalPanel
          approval={pendingToolApproval}
          selection={approvalSelection}
          width={contentWidth}
        />
      ) : null}

      {modelSettings && !pendingToolApproval ? (
        <ModelSettingsPanel state={modelSettings} width={contentWidth} />
      ) : null}

      {!pendingToolApproval &&
      !modelSettingsOpen &&
      slashSuggestions.length > 0 ? (
        <SlashSuggest
          commands={slashSuggestions}
          selectedIndex={slashSelectedIndex}
          hiddenCount={slashSuggestionResult.hiddenCount}
          width={contentWidth}
        />
      ) : null}

      <Composer
        value={input}
        onChange={(next) => setInput(stripMouseArtifactsFromInput(next))}
        onSubmit={submit}
        disabled={Boolean(pendingToolApproval) || modelSettingsOpen}
        modelLabel={modelLabel}
        permissionMode={permissionMode}
        width={contentWidth}
      />
    </Box>
  );

  // localeGeneration forces welcome chrome to re-resolve t() after /lang.
  void localeGeneration;
  const homeBody = (
    <WelcomeHome
      version={version}
      modelLabel={modelLabel === 'no model' ? undefined : modelLabel}
      width={contentWidth}
      notice={appError ?? (importPrompt ? formatImportPrompt(importPrompt) : undefined)}
      recentSessions={recentSessions}
      selectedSessionIndex={selectedRecentSession}
    />
  );

  const chatBody = (
    <MessageViewport
      messages={messages}
      streamingMessageId={streamingMessageId}
      scrollOffset={shellMode ? scrollOffset : 0}
      height={shellMode ? messageViewportHeight : undefined}
      columns={contentWidth}
      onScrollBounds={shellMode ? handleScrollBounds : undefined}
    />
  );

  return (
    <AppShell
      shellMode={shellMode}
      columns={columns}
      rows={rows}
      contentWidth={contentWidth}
      isHome={isHome}
      header={header}
      homeBody={homeBody}
      chatBody={chatBody}
      footer={footer}
    />
  );
}

function safeListRecentSessions(
  sessionStore: AppProps['sessionStore'],
  cwd: string
): SessionSummary[] {
  if (!sessionStore) {
    return [];
  }
  try {
    return sessionStore.listRecent(cwd, 4);
  } catch {
    return [];
  }
}

function toStoredSessionMessage(message: ChatMessage): StoredSessionMessage {
  return {
    id: message.id,
    from: message.from,
    text: message.text,
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    ...(message.durationMs !== undefined
      ? { durationMs: message.durationMs }
      : {}),
    ...(message.expanded !== undefined ? { expanded: message.expanded } : {}),
    ...(message.tool ? { tool: message.tool } : {})
  };
}

function fromStoredSessionMessage(message: StoredSessionMessage): ChatMessage {
  return {
    id: message.id,
    from: message.from,
    text: message.text,
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    ...(message.durationMs !== undefined
      ? { durationMs: message.durationMs }
      : {}),
    ...(message.expanded !== undefined ? { expanded: message.expanded } : {}),
    ...(message.tool && typeof message.tool === 'object'
      ? { tool: message.tool as ToolCallState }
      : {})
  };
}

function formatSessionError(prefixKey: MessageKey, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return t('session.errorDetail', { prefix: t(prefixKey), detail });
}

function createMemoryRuntime(): AgentRuntime {
  return new AgentRuntime({
    traceStore: new ObservableTraceStore(new InMemoryTraceStore())
  });
}

class InMemoryTraceStore implements TraceStore {
  private readonly events: TraceEvent[] = [];

  async append(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }

  async listRunIds(): Promise<string[]> {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const runId = this.events[index]?.runId;
      if (!runId || seen.has(runId)) {
        continue;
      }
      seen.add(runId);
      ids.push(runId);
    }
    return ids;
  }
}
