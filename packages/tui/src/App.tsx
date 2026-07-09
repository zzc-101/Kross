import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useInput } from 'ink';

import {
  AgentRuntime,
  nextPermissionMode,
  isPermissionMode,
  ObservableTraceStore,
  type AgentMode,
  type AgentResult,
  type ConfigImportController,
  type ConfigImportPrompt,
  type ContextInspection,
  type ExternalAgentSource,
  type PendingToolApproval,
  type PermissionMode,
  type TraceEvent,
  type TraceStore
} from '@kross/core';

import {
  ApprovalPanel,
  Composer,
  buildToolState,
  ensureToolItems,
  filterSlashCommands,
  formatCwdLabel,
  formatSlashHelp,
  formatToolTitle,
  HeaderBar,
  isAggregatableTool,
  MessageViewport,
  SlashSuggest,
  ThinkingIndicator,
  WelcomeHome,
  useTerminalSize,
  type ChatMessage,
  type ToolCallState
} from './ui';
import {
  mergeToolItem,
  toToolItem
} from './ui/toolDisplay';
import { useMouseScroll } from './ui/useMouseScroll';

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
}

export interface AppTestApi {
  submit: (value: string) => Promise<void>;
  choosePlanApproval: (approved: boolean) => Promise<void>;
  chooseToolApproval: (approved: boolean) => Promise<void>;
  setInput: (value: string) => void;
  toggleCollapse: () => void;
  toggleToolGroup: () => void;
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
  version = '0.1.0'
}: AppProps) {
  const { columns, rows, isTty } = useTerminalSize();
  const shellMode = fullscreen && isTty;
  const cwdLabel = useMemo(() => formatCwdLabel(cwd), [cwd]);
  const initialImportPrompt = useMemo(
    () => configImportController?.getPrompt(),
    [configImportController]
  );
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
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
  const modelLabel = useMemo(
    () => agentRuntime.getModelLabel(),
    [agentRuntime, runtimeGeneration]
  );
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
  /** 消息视口向上滚动的行数；0 = 贴底 */
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxScrollOffsetRef = useRef(0);
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

  const slashSuggestions = useMemo(
    () => filterSlashCommands(input),
    [input]
  );

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
      setMessages((current) => [
        ...current,
        {
          id,
          from,
          text,
          createdAt: new Date().toISOString(),
          expanded: options.expanded
        }
      ]);
      // 新消息时回到底部（跟读最新）
      setScrollOffset(0);
      return id;
    },
    []
  );

  const cyclePermissionMode = useCallback(() => {
    const next = nextPermissionMode(permissionMode);
    agentRuntime.setPermissionMode(next);
    setPermissionMode(next);
    // 页脚/header 已展示当前权限，不再往会话刷 system 提示
  }, [agentRuntime, permissionMode]);

  const updateMessage = useCallback((id: number, text: string) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === id ? { ...message, text } : message
      )
    );
  }, []);

  const upsertToolMessage = useCallback((key: string, tool: ToolCallState) => {
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
            items
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
          items
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
      const state = buildToolState(tool.name, tool.risk, [toToolItem(tool)]);
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
    setScrollOffset(0);
    return holder.id;
  }, []);

  /** 切换最近一条 thinking 的展开/折叠。 */
  const toggleLastCollapsible = useCallback(() => {
    setMessages((current) => {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const message = current[index];
        if (!message || message.from !== 'thinking') {
          continue;
        }
        const next = current.slice();
        next[index] = { ...message, expanded: message.expanded !== true };
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
            updateMessage(thinkingMessageId, thinkingText);
            setStreamingMessageId(thinkingMessageId);
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
            updateMessage(streamedMessageId, streamedText);
            setStreamingMessageId(streamedMessageId);
          }
          continue;
        }

        result = event.result;
        setAwaitingReply(false);
        setStreamingMessageId(undefined);
      }
    } catch (error) {
      append('system', `运行出错：${error instanceof Error ? error.message : String(error)}`);
      setStatus('ready');
      setAwaitingReply(false);
      setStreamingMessageId(undefined);
      return;
    }

    if (!result) {
      setStatus('ready');
      setStreamingMessageId(undefined);
      return;
    }

    if (result.mode === 'cross-repo' && result.status === 'cancelled') {
      setStatus('waiting-approval');
      setPendingCrossRepoPlan({ prompt, mode: options.requestedMode ?? mode });
      append('system', '检测到 cross-repo 任务，已在执行前暂停，等待确认计划。输入 /approve 继续，或 /reject 取消。');
      return;
    }

    if (result.status === 'approval-required' && result.pendingApproval) {
      setStatus('approval-required');
      setPendingToolApproval(result.pendingApproval);
      setApprovalSelection('approve');
      append('system', result.summary);
      return;
    }

    // 已按 turn 流式写入气泡时，不要用跨轮拼接的 fullText 覆盖最后一条
    if (!sawAgentText && result.summary.trim().length > 0) {
      append('agent', result.summary);
    }
    setStatus('ready');
  }, [agentRuntime, append, mode, updateMessage]);

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
      approved ? '已批准工具调用，继续执行。' : '已拒绝工具调用，继续让模型调整方案。'
    );

    let result: AgentResult;
    try {
      result = await agentRuntime.resolveToolApproval({
        runId: pendingToolApproval.runId,
        approved
      });
    } catch (error) {
      append(
        'system',
        `处理审批时出错：${error instanceof Error ? error.message : String(error)}`
      );
      setStatus('ready');
      setAwaitingReply(false);
      return;
    }

    // 模型可能在同一轮里继续请求其他高风险工具，需要再次进入审批。
    if (result.status === 'approval-required' && result.pendingApproval) {
      setStatus('approval-required');
      setAwaitingReply(false);
      setPendingToolApproval(result.pendingApproval);
      setApprovalSelection('approve');
      append('system', result.summary);
      return;
    }

    appendApprovalResult(append, result);
    setAwaitingReply(false);
    setStatus('ready');
  }, [agentRuntime, append, pendingToolApproval]);

  const choosePlanApproval = useCallback(async (approved: boolean) => {
    if (!pendingCrossRepoPlan) {
      append('system', '当前没有等待确认的 cross-repo 计划。');
      return;
    }

    const pending = pendingCrossRepoPlan;
    setPendingCrossRepoPlan(undefined);

    if (!approved) {
      setStatus('ready');
      append('system', '已取消 cross-repo 计划。');
      return;
    }

    append('system', '已确认 cross-repo 计划，继续执行。');
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

  const scrollBy = useCallback((delta: number) => {
    if (delta === 0) {
      return;
    }
    setScrollOffset((current) => {
      const next = current + delta;
      if (next <= 0) {
        return 0;
      }
      return Math.min(maxScrollOffsetRef.current, next);
    });
  }, []);

  // 鼠标滚轮 / Mac 触摸板（需终端 mouse tracking，全屏启动时已开启）
  // 首页 maxScroll=0 时 scrollBy 不会产生可见变化
  useMouseScroll(
    (direction, steps) => {
      if (pendingToolApproval) {
        return;
      }
      const step = Math.max(1, steps) * 3;
      // up = 看更早消息（增大 offset）；down = 回底部方向
      scrollBy(direction === 'up' ? step : -step);
    },
    shellMode
  );

  useInput((inputKey, key) => {
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

    setInput('');
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
        choosePlanApproval
      )
    ) {
      return;
    }

    if (processingRef.current) {
      queueRef.current.push(trimmed);
      setQueueLength(queueRef.current.length);
      append('system', `已加入队列：${queueRef.current.length}`);
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
    runTurn,
    slashSelectedIndex,
    slashSuggestions,
    pendingCrossRepoPlan,
    choosePlanApproval,
    toggleLastCollapsible
  ]);

  useEffect(() => {
    onReady?.({
      submit,
      choosePlanApproval,
      chooseToolApproval,
      setInput,
      toggleCollapse: toggleLastCollapsible,
      toggleToolGroup: toggleLastToolGroup
    });
  }, [
    chooseToolApproval,
    choosePlanApproval,
    onReady,
    submit,
    toggleLastCollapsible,
    toggleLastToolGroup
  ]);

  const hasUserActivity = messages.some((message) => message.from === 'user');
  const isHome = !hasUserActivity && status === 'ready' && !pendingToolApproval;
  const contentWidth = Math.max(40, columns - (shellMode ? 2 : 4));
  // 视口高度：总行 − 顶栏(≈3) − 底栏 Composer(≈5) − padding
  // 给足高度，减少单条超长消息被迫裁剪的概率
  const messageViewportHeight = Math.max(8, rows - 10);

  const handleScrollBounds = useCallback(
    (bounds: { maxScrollOffset: number; totalRows: number }) => {
      maxScrollOffsetRef.current = bounds.maxScrollOffset;
      setScrollOffset((current) =>
        Math.min(current, bounds.maxScrollOffset)
      );
    },
    []
  );

  const header = (
    <HeaderBar
      projectName={projectName}
      branch={branch}
      cwdLabel={cwdLabel}
      mode={mode}
      status={status}
      queueLength={queueLength}
      permissionMode={permissionMode}
      runtimeError={runtimeError}
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
        />
      ) : null}

      {!pendingToolApproval && slashSuggestions.length > 0 ? (
        <SlashSuggest
          commands={slashSuggestions}
          selectedIndex={slashSelectedIndex}
        />
      ) : null}

      <Composer
        value={input}
        onChange={setInput}
        onSubmit={submit}
        disabled={Boolean(pendingToolApproval)}
        modelLabel={modelLabel}
        permissionMode={permissionMode}
        width={contentWidth}
      />
    </Box>
  );

  const homeBody = (
    <WelcomeHome
      version={version}
      modelLabel={modelLabel === 'no model' ? undefined : modelLabel}
      width={contentWidth}
      notice={
        runtimeError
          ? `模型配置加载失败：${runtimeError}`
          : importPrompt
            ? formatImportPrompt(importPrompt)
            : undefined
      }
      headline={modelLabel !== 'no model' ? `${modelLabel} ready` : 'Ready when you are'}
      subtitle="Local-first agent · plan, tools, and traces in your workspace."
      tip="Press shift+tab to cycle permission · ctrl+o toggles thinking."
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

  // 全屏壳：固定高度三区；测试/非 TTY 退化为文档流
  // 顶栏统一走 HeaderBar（branch + cwd），避免首页/对话两套路径逻辑
  if (shellMode) {
    return (
      <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
        {header}
        <Box
          flexGrow={1}
          flexShrink={1}
          flexDirection="column"
          overflowY="hidden"
          justifyContent={isHome ? 'center' : 'flex-end'}
          alignItems={isHome ? 'center' : 'stretch'}
          minHeight={3}
        >
          {isHome ? homeBody : chatBody}
        </Box>
        {footer}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} width={contentWidth}>
      {header}
      {isHome ? homeBody : chatBody}
      {footer}
    </Box>
  );
}

function createMemoryRuntime(): AgentRuntime {
  return new AgentRuntime({
    traceStore: new ObservableTraceStore(new InMemoryTraceStore())
  });
}

function handleTraceEvent(
  event: TraceEvent,
  handlers: {
    upsertToolMessage: (key: string, tool: ToolCallState) => number;
    setLoadingVariant: (variant: 'thinking' | 'tool') => void;
    setAwaitingReply: (value: boolean) => void;
    setStreamingMessageId: (id: number | undefined) => void;
  }
): void {
  const payload = event.payload;
  const toolName = typeof payload.toolName === 'string' ? payload.toolName : undefined;
  if (!toolName) {
    return;
  }

  const callId = typeof payload.callId === 'string' ? payload.callId : undefined;
  // 始终带 runId，避免跨 run 用短 callId 串历史卡片
  const key = `${event.runId}:${callId ?? toolName}`;
  const risk = typeof payload.risk === 'string' ? payload.risk : undefined;
  const summary = typeof payload.summary === 'string' ? payload.summary : undefined;
  const durationMs =
    typeof payload.durationMs === 'number' ? payload.durationMs : undefined;
  const inputPreview = formatToolInputPreview(payload.input);

  if (event.type === 'tool_call.approval_required') {
    handlers.setLoadingVariant('tool');
    handlers.setAwaitingReply(false);
    handlers.setStreamingMessageId(undefined);
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'awaiting',
      summary: typeof payload.reason === 'string' ? payload.reason : 'awaiting approval',
      inputPreview
    });
    return;
  }

  if (event.type === 'tool_call.started') {
    handlers.setLoadingVariant('tool');
    handlers.setAwaitingReply(true);
    handlers.setStreamingMessageId(undefined);
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'running',
      inputPreview
    });
    return;
  }

  if (event.type === 'tool_call.completed') {
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'completed',
      summary,
      inputPreview,
      durationMs
    });
    return;
  }

  if (event.type === 'tool_call.failed') {
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'failed',
      summary:
        summary ??
        (typeof payload.message === 'string' ? payload.message : 'tool failed'),
      inputPreview,
      durationMs
    });
    return;
  }

  if (event.type === 'tool_call.denied') {
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'denied',
      summary: typeof payload.reason === 'string' ? payload.reason : 'denied',
      inputPreview
    });
  }
}

function appendApprovalResult(
  append: (
    from: ChatMessage['from'],
    text: string,
    options?: { expanded?: boolean }
  ) => void,
  result: AgentResult
): void {
  if (result.thinking && result.thinking.trim().length > 0) {
    append('thinking', result.thinking);
  }
  if (result.summary.trim().length > 0) {
    append('agent', result.summary);
  }
}

function formatToolInputPreview(input: unknown): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input === 'string') {
    return input;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function handleCommand(
  value: string,
  append: (
    from: ChatMessage['from'],
    text: string,
    options?: { expanded?: boolean }
  ) => void,
  setMode: (mode: AgentMode) => void,
  setPermissionMode: (mode: PermissionMode) => void,
  runtime: AgentRuntime,
  mode: AgentMode,
  importPrompt: ConfigImportPrompt | undefined,
  configImportController: ConfigImportController | undefined,
  setImportPrompt: (prompt: ConfigImportPrompt | undefined) => void,
  refreshRuntime: () => void,
  toggleLastCollapsible: () => void,
  hasPendingCrossRepoPlan: boolean,
  choosePlanApproval: (approved: boolean) => Promise<void>
): boolean {
  if (!value.startsWith('/')) {
    return false;
  }

  if (value === '/help') {
    append('agent', formatSlashHelp(), { expanded: true });
    return true;
  }

  if (value === '/status') {
    append(
      'agent',
      `当前运行在本地 TUI。mode=${mode} · perm=${runtime.getPermissionMode()}`
    );
    return true;
  }

  if (value === '/context') {
    append(
      'agent',
      formatContextInspection(
        runtime.inspectContext({
          requestedMode: mode,
          currentUserInput: ''
        })
      ),
      { expanded: true }
    );
    return true;
  }

  if (value === '/expand') {
    toggleLastCollapsible();
    append('system', '已切换最近一条 thinking 的折叠状态（也可用 ctrl+o）。');
    return true;
  }

  if (value === '/approve' || value === '/reject') {
    if (!hasPendingCrossRepoPlan) {
      append('system', '当前没有等待确认的 cross-repo 计划。');
      return true;
    }
    void choosePlanApproval(value === '/approve');
    return true;
  }

  if (value === '/import' || value.startsWith('/import ')) {
    handleImportCommand({
      value,
      append,
      importPrompt,
      configImportController,
      setImportPrompt,
      refreshRuntime
    });
    return true;
  }

  if (value === '/mode') {
    append('agent', '用法：/mode auto|normal|cross-repo');
    return true;
  }

  if (value.startsWith('/mode ')) {
    const nextMode = value.replace('/mode ', '').trim();
    if (isAgentMode(nextMode)) {
      setMode(nextMode);
      append('system', `已切换到 ${nextMode} 模式`);
    } else {
      append('agent', '未知模式，可选：auto、normal、cross-repo');
    }
    return true;
  }

  if (value === '/perm') {
    append('agent', '用法：/perm default|classifier|auto · 也可按 shift+tab 循环切换');
    return true;
  }

  if (value.startsWith('/perm ')) {
    const nextPerm = value.replace('/perm ', '').trim();
    if (isPermissionMode(nextPerm)) {
      runtime.setPermissionMode(nextPerm);
      setPermissionMode(nextPerm);
      // 状态已反映在 header / 输入框页脚，无需再输出提示
    } else {
      append('agent', '未知权限模式，可选：default、classifier、auto');
    }
    return true;
  }

  if (value === '/trace' || value === '/diff') {
    append('agent', `${value} 将在后续版本展开。`);
    return true;
  }

  append('agent', `未知命令：${value}。输入 /help 查看可用命令。`);
  return true;
}

function isAgentMode(value: string): value is AgentMode {
  return value === 'auto' || value === 'normal' || value === 'cross-repo';
}

function handleImportCommand(input: {
  value: string;
  append: (
    from: ChatMessage['from'],
    text: string,
    options?: { expanded?: boolean }
  ) => void;
  importPrompt: ConfigImportPrompt | undefined;
  configImportController: ConfigImportController | undefined;
  setImportPrompt: (prompt: ConfigImportPrompt | undefined) => void;
  refreshRuntime: () => void;
}): void {
  if (!input.configImportController) {
    input.append('agent', '当前没有可导入的 Claude Code 或 Codex 配置。');
    return;
  }

  const target = input.value.replace('/import', '').trim();
  if (target.length === 0) {
    input.append('agent', formatImportUsage(input.importPrompt));
    return;
  }
  if (target === 'skip') {
    const result = input.configImportController.skip();
    input.setImportPrompt(undefined);
    input.append('agent', `已跳过配置导入。记录已保存到 ${result.configPath}`);
    return;
  }
  if (!isExternalAgentSource(target)) {
    input.append('agent', formatImportUsage(input.importPrompt));
    return;
  }

  try {
    const result = input.configImportController.importSource(target);
    input.setImportPrompt(undefined);
    input.refreshRuntime();
    input.append(
      'agent',
      [
        `已导入 ${result.candidate.displayName} 配置。`,
        `配置文件: ${result.configPath}`,
        `provider: ${result.config.llm?.provider}`,
        `model: ${result.config.llm?.model}`,
        `baseUrl: ${result.config.llm?.baseUrl ?? '默认'}`,
        `credential: ${
          result.config.llm?.apiKey || result.config.llm?.authToken ? '已配置' : '未配置'
        }`
      ].join('\n'),
      { expanded: true }
    );
  } catch (error) {
    input.append(
      'agent',
      error instanceof Error ? error.message : `导入失败：${String(error)}`
    );
  }
}

function isExternalAgentSource(value: string): value is ExternalAgentSource {
  return value === 'claude' || value === 'codex';
}

function formatImportPrompt(prompt: ConfigImportPrompt): string {
  const sources = prompt.candidates.map((candidate) => candidate.displayName);
  if (prompt.candidates.length === 1) {
    const candidate = prompt.candidates[0];
    return [
      `检测到 ${candidate?.displayName} 配置。`,
      `输入 /import ${candidate?.source} 一键导入，或输入 /import skip 跳过。`
    ].join('\n');
  }

  return [
    `检测到 ${sources.join(' 和 ')} 配置。`,
    '请选择一个导入：/import claude 或 /import codex；也可以输入 /import skip 跳过。'
  ].join('\n');
}

function formatImportUsage(prompt: ConfigImportPrompt | undefined): string {
  const commands =
    prompt?.candidates.length
      ? prompt.candidates.map((candidate) => `/import ${candidate.source}`).join(' | ')
      : '/import claude | /import codex';
  return `用法：${commands} | /import skip`;
}

function formatContextInspection(snapshot: ContextInspection): string {
  const sectionLines = Object.entries(snapshot.report.sections)
    .map(([section, chars]) => `- ${section}: ${chars}`)
    .join('\n');
  const contributorLines = snapshot.report.contributors
    .slice()
    .sort((left, right) => right.injectedChars - left.injectedChars)
    .slice(0, 6)
    .map(
      (contributor) =>
        `- ${contributor.title} [${contributor.section}/${contributor.status}]: ${contributor.injectedChars}/${contributor.rawChars}`
    )
    .join('\n');

  return [
    'Context',
    `mode: ${snapshot.mode}`,
    `总字符: ${snapshot.estimatedChars}`,
    `included sources: ${snapshot.includedSources.length}`,
    `dropped sources: ${snapshot.droppedSources.length}`,
    'sections:',
    sectionLines,
    'contributors:',
    contributorLines.length > 0 ? contributorLines : '- none'
  ].join('\n');
}

class InMemoryTraceStore implements TraceStore {
  private readonly events: TraceEvent[] = [];

  async append(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }
}
