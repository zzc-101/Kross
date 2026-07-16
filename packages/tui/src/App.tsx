import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box } from 'ink';

import {
  nextPermissionMode,
  t,
  type AgentMode,
  type AgentRuntime,
  type ConfigImportController,
  type ConfigImportPrompt,
  type HybridSessionStore,
  type PendingToolApproval,
  type PermissionMode,
  type TodoStoreSnapshot
} from '@kross/core';

import {
  ApprovalPanel,
  Composer,
  getSlashCommandSuggestions,
  formatCwdLabel,
  HeaderBar,
  resolveHeaderHeight,
  MessageViewport,
  ModelSettingsPanel,
  SlashSuggest,
  ThinkingIndicator,
  SubagentPanel,
  WelcomeHome,
  useTerminalSize,
  type ChatMessage
} from './ui';
import { useMouseScroll } from './ui/useMouseScroll';
import { stripMouseArtifactsFromInput } from './terminal/mouseTracking';
import {
  AppShell,
  resolveMessageViewportHeight
} from './app/AppShell';
import { formatImportPrompt } from './app/appCommands';
import { useViewportScroll } from './app/useViewportScroll';
import { createMemoryRuntime } from './app/runtimeBootstrap';
import { useAppMessages } from './app/useAppMessages';
import { useAppSession } from './app/useAppSession';
import { useAgentRun } from './app/useAgentRun';
import { useModelSettingsPanel } from './app/useModelSettingsPanel';
import { useSubagentTrace } from './app/useSubagentTrace';
import { useMouseClickDispatch } from './app/useMouseClickDispatch';
import { useAppKeyboard } from './app/useAppKeyboard';
import { useAppSubmit } from './app/useAppSubmit';
import { useFooterHeight } from './app/useFooterHeight';

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
    | 'upsertContextState'
    | 'upsertWorkState'
  >;
}

export interface AppTestApi {
  submit: (value: string) => Promise<void>;
  choosePlanApproval: (approved: boolean) => Promise<void>;
  chooseToolApproval: (approved: boolean) => Promise<void>;
  setInput: (value: string) => void;
  toggleCollapse: () => void;
  toggleToolGroup: () => void;
  /** Expand/collapse the header todo list (same as clicking Todo chip). */
  toggleTodoExpand: () => void;
  /** Expand/collapse the subagent strip under the conversation. */
  toggleSubagentExpand: () => void;
  resumeSession: (selector?: string) => Promise<boolean>;
  flushSession: () => void;
  requestExit: () => void;
  interruptCurrentRun: () => boolean;
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
  const [mode, setMode] = useState<AgentMode>(
    () => agentRuntime.getSessionMode?.() ?? initialMode
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() =>
    agentRuntime.getPermissionMode()
  );

  // 同步 /mode 与 SetMode 工具到 runtime + UI
  useEffect(() => {
    agentRuntime.setSessionMode(mode);
  }, [agentRuntime, mode]);

  useEffect(() => {
    const unsub = agentRuntime.onModeChanged(({ mode: next }) => {
      setMode(next);
    });
    return unsub;
  }, [agentRuntime]);
  // 不 memo：/model 会就地 setModel/setLlmClient，依赖 agentRuntime 引用不变，
  // 需在 append 触发的重渲染中重新读取，否则底栏一直显示旧模型。
  const modelLabel = agentRuntime.getModelLabel();
  const [todoSnapshot, setTodoSnapshot] = useState<TodoStoreSnapshot | undefined>(
    () => agentRuntime.getTodoStore()?.snapshot()
  );
  const [todoExpanded, setTodoExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('ready');
  const [queueLength, setQueueLength] = useState(0);
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | undefined>();
  const [pendingConductorPlan, setPendingConductorPlan] = useState<{
    prompt: string;
    mode: AgentMode;
  } | undefined>();
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [loadingVariant, setLoadingVariant] = useState<'thinking' | 'tool'>('thinking');
  const [streamingMessageId, setStreamingMessageId] = useState<number | undefined>();
  const [approvalSelection, setApprovalSelection] = useState<'approve' | 'reject'>('approve');
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);

  const {
    scrollOffset,
    scrollBy,
    resetToBottom,
    handleScrollBounds
  } = useViewportScroll();

  const initialMessages: ChatMessage[] = initialImportPrompt
    ? [
        {
          id: 1,
          from: 'system' as const,
          text: formatImportPrompt(initialImportPrompt)
        }
      ]
    : [];

  const persistMessageRef = useRef<(message: ChatMessage) => void>(() => {});
  const persistMessageProxy = useCallback(
    (message: ChatMessage) => persistMessageRef.current(message),
    []
  );

  const {
    messages,
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
    toggleLastToolGroup,
    setMessages
  } = useAppMessages({
    initialMessages,
    initialNextMessageId: initialImportPrompt ? 2 : 1,
    persistMessage: persistMessageProxy,
    resetToBottom
  });

  const processingRef = useRef(false);
  const queueRef = useRef<string[]>([]);
  const commandAbortControllerRef = useRef<AbortController>();

  const {
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
  } = useAppSession({
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
  });

  persistMessageRef.current = persistMessage;

  useEffect(() => {
    setPermissionMode(agentRuntime.getPermissionMode());
  }, [agentRuntime]);

  // Subscribe to session todos so TodoWrite refreshes the header list.
  useEffect(() => {
    const store = agentRuntime.getTodoStore();
    setTodoSnapshot(store?.snapshot());
    if (!store) {
      return;
    }
    return store.onChange(() => {
      setTodoSnapshot(store.snapshot());
    });
  }, [agentRuntime]);

  const slashSuggestionResult = useMemo(
    () =>
      getSlashCommandSuggestions(input, {
        hasPendingConductorPlan: pendingConductorPlan !== undefined
      }),
    // localeGeneration: re-resolve descriptions after /lang
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
    [input, pendingConductorPlan, localeGeneration]
  );
  const slashSuggestions = slashSuggestionResult.commands;

  useEffect(() => {
    setSlashSelectedIndex(0);
  }, [input]);

  const {
    subagents,
    subagentExpanded,
    setSubagentExpanded,
    toggleSubagentExpand
  } = useSubagentTrace({
    agentRuntime,
    append,
    upsertToolMessage,
    setLoadingVariant,
    setAwaitingReply,
    setStreamingMessageId
  });

  const cyclePermissionMode = useCallback(() => {
    const next = nextPermissionMode(permissionMode);
    agentRuntime.setPermissionMode(next);
    setPermissionMode(next);
    // 页脚/header 已展示当前权限，不再往会话刷 system 提示
  }, [agentRuntime, permissionMode]);

  const {
    runTurn,
    chooseToolApproval,
    choosePlanApproval,
    interruptCurrentRun
  } = useAgentRun({
    agentRuntime,
    mode,
    append,
    enqueueMessageUpdate,
    flushMessageUpdates,
    finalizeThinkingDurations,
    toolMessageIdsRef,
    setStatus,
    setAwaitingReply,
    setLoadingVariant,
    setStreamingMessageId,
    setPendingToolApproval,
    setApprovalSelection,
    setPendingConductorPlan,
    pendingToolApproval,
    pendingConductorPlan,
    processingRef
  });

  const interruptForeground = useCallback(() => {
    if (interruptCurrentRun()) {
      return true;
    }
    const controller = commandAbortControllerRef.current;
    if (!controller) {
      return false;
    }
    if (!controller.signal.aborted) {
      setStatus('interrupting');
      setAwaitingReply(true);
      controller.abort(new Error('用户按下 Esc'));
    }
    return true;
  }, [interruptCurrentRun]);

  const {
    modelSettings,
    modelSettingsOpen,
    openModelSettings,
    handleModelSettingsKey,
    toggleModelSettings
  } = useModelSettingsPanel({
    agentRuntime,
    append,
    pendingToolApproval
  });

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

  const hasUserActivity = messages.some((message) => message.from === 'user');
  const appError = runtimeError
    ? t('app.runtimeFallback', { error: runtimeError })
    : sessionNotice;
  const isHome =
    !hasUserActivity &&
    status === 'ready' &&
    !pendingToolApproval &&
    !modelSettingsOpen;

  useAppKeyboard({
    requestExit,
    toggleModelSettings,
    pendingToolApproval,
    modelSettings,
    handleModelSettingsKey,
    toggleLastCollapsible,
    toggleLastToolGroup,
    isHome,
    selectedRecentSession,
    setSelectedRecentSession,
    input,
    recentSessionsLength: recentSessions.length,
    rows,
    scrollBy,
    cyclePermissionMode,
    approvalSelection,
    setApprovalSelection,
    chooseToolApproval,
    interruptCurrentRun: interruptForeground,
    slashSuggestions,
    slashSelectedIndex,
    setSlashSelectedIndex,
    setInput
  });

  const submit = useAppSubmit({
    isHome,
    selectedRecentSession,
    resumeSession,
    openModelSettings,
    slashSuggestions,
    slashSelectedIndex,
    openSessionPicker,
    ensureActiveSession,
    append,
    setInput,
    agentRuntime,
    setMode,
    setPermissionMode,
    mode,
    importPrompt,
    configImportController,
    setImportPrompt,
    setRuntimeGeneration,
    toggleLastCollapsible,
    pendingConductorPlan,
    choosePlanApproval,
    setLocaleGeneration,
    processingRef,
    queueRef,
    setQueueLength,
    runTurn,
    commandAbortControllerRef,
    setStatus,
    setAwaitingReply
  });

  const toggleTodoExpand = useCallback(() => {
    setTodoExpanded((current) => !current);
  }, []);

  useEffect(() => {
    onReady?.({
      submit,
      choosePlanApproval,
      chooseToolApproval,
      setInput,
      toggleCollapse: toggleLastCollapsible,
      toggleToolGroup: toggleLastToolGroup,
      toggleTodoExpand,
      toggleSubagentExpand,
      resumeSession,
      flushSession,
      requestExit,
      interruptCurrentRun: interruptForeground,
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
    interruptForeground,
    toggleLastCollapsible,
    toggleLastToolGroup,
    toggleTodoExpand,
    toggleSubagentExpand
  ]);

  const contentWidth = Math.max(40, columns - (shellMode ? 2 : 4));

  const contextUsage = useMemo(
    () =>
      agentRuntime.getContextUsage({
        requestedMode: mode,
        currentUserInput: input,
        env: process.env
      }),
    // messages / 工具结果变化后需要刷新占用
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用长度与 generation 触发重算
    [agentRuntime, mode, input, messages.length, runtimeGeneration, status, streamingMessageId]
  );

  // 动态计算 footer 高度，防止 header + viewport + footer > rows 导致溢出
  const footerHeight = useFooterHeight({
    pendingToolApproval,
    modelSettings,
    modelSettingsOpen,
    status,
    awaitingReply,
    subagents,
    subagentExpanded,
    slashSuggestions,
    slashHiddenCount: slashSuggestionResult.hiddenCount
  });

  const headerHeight = resolveHeaderHeight({
    compact: isHome,
    hasError: Boolean(appError),
    todoCount: todoSnapshot?.todos.length ?? 0,
    todoExpanded
  });
  // paddingX 1 on each side doesn't affect height
  const messageViewportHeight = resolveMessageViewportHeight({
    rows,
    headerHeight,
    footerHeight
  });

  useMouseClickDispatch({
    shellMode,
    pendingToolApproval,
    modelSettingsOpen,
    columns,
    contentWidth,
    isHome,
    appError,
    todoCount: todoSnapshot?.todos.length ?? 0,
    todoExpanded,
    setTodoExpanded,
    subagents,
    subagentExpanded,
    setSubagentExpanded,
    headerHeight,
    messageViewportHeight,
    messages,
    scrollOffset,
    streamingMessageId,
    clickPaintCacheRef,
    toggleThinkingById,
    toggleToolById
  });

  const header = (
    <HeaderBar
      projectName={projectName}
      branch={branch}
      cwdLabel={cwdLabel}
      mode={mode}
      status={status}
      queueLength={queueLength}
      todoSnapshot={todoSnapshot}
      todoExpanded={todoExpanded}
      runtimeError={appError}
      compact={isHome}
      contextUsageLabel={contextUsage.headerLabel}
      contextUsageRatio={contextUsage.headerRatio}
    />
  );

  // 思考指示 → 输入区 → 最底部单行子代理条（用户圈定区域）
  const footer = (
    <Box flexDirection="column" flexShrink={0} width={contentWidth}>
      <ThinkingIndicator
        active={
          (status === 'responding' || status === 'interrupting') &&
          awaitingReply
        }
        variant={status === 'interrupting' ? 'cancelling' : loadingVariant}
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
        disabled={
          Boolean(pendingToolApproval) ||
          modelSettingsOpen ||
          status === 'interrupting'
        }
        modelLabel={modelLabel}
        agentMode={mode}
        permissionMode={permissionMode}
        width={contentWidth}
        bottomGap={subagents.length > 0 ? 0 : undefined}
      />

      <SubagentPanel subagents={subagents} width={contentWidth} />
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
