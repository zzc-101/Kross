import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useInput } from 'ink';

import {
  AgentRuntime,
  nextPermissionMode,
  isPermissionMode,
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
  filterSlashCommands,
  formatSlashHelp,
  HeaderBar,
  MessageList,
  SessionTip,
  SlashSuggest,
  ThinkingIndicator,
  type ChatMessage
} from './ui';

export interface AppProps {
  runtime?: AgentRuntime;
  createRuntime?: () => AgentRuntime;
  configImportController?: ConfigImportController;
  initialMode?: AgentMode;
  projectName?: string;
  onReady?: (api: AppTestApi) => void;
}

export interface AppTestApi {
  submit: (value: string) => Promise<void>;
  chooseToolApproval: (approved: boolean) => Promise<void>;
}

export function App({
  runtime,
  createRuntime,
  configImportController,
  initialMode = 'auto',
  projectName = 'local',
  onReady
}: AppProps) {
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
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('ready');
  const [queueLength, setQueueLength] = useState(0);
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | undefined>();
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [loadingVariant, setLoadingVariant] = useState<'thinking' | 'tool'>('thinking');
  const [streamingMessageId, setStreamingMessageId] = useState<number | undefined>();
  const [approvalSelection, setApprovalSelection] = useState<'approve' | 'reject'>('approve');
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: 1,
      from: 'agent',
      text: 'Welcome. 输入任务，或输入 /help 查看命令。'
    },
    ...(initialImportPrompt
      ? [
          {
            id: 2,
            from: 'agent' as const,
            text: formatImportPrompt(initialImportPrompt)
          }
        ]
      : [])
  ]);
  const nextMessageIdRef = useRef(initialImportPrompt ? 3 : 2);
  const processingRef = useRef(false);
  const queueRef = useRef<string[]>([]);

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

  const append = useCallback((from: ChatMessage['from'], text: string) => {
    const id = nextMessageIdRef.current;
    nextMessageIdRef.current += 1;
    setMessages((current) => [
      ...current,
      {
        id,
        from,
        text
      }
    ]);
    return id;
  }, []);

  const cyclePermissionMode = useCallback(() => {
    const next = nextPermissionMode(permissionMode);
    agentRuntime.setPermissionMode(next);
    setPermissionMode(next);
    append('agent', `已切换权限模式：${next}（shift+tab）`);
  }, [agentRuntime, append, permissionMode]);

  const updateMessage = useCallback((id: number, text: string) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === id ? { ...message, text } : message
      )
    );
  }, []);

  const runTurn = useCallback(async (prompt: string) => {
    setStatus('responding');
    setAwaitingReply(true);
    setLoadingVariant('thinking');
    setStreamingMessageId(undefined);
    let streamedMessageId: number | undefined;
    let streamedText = '';
    let result: AgentResult | undefined;

    try {
      for await (const event of agentRuntime.runStreaming({
        input: prompt,
        requestedMode: mode,
        approvals: { plan: false }
      })) {
        if (event.type === 'text-delta') {
          streamedText += event.text;
          if (streamedMessageId === undefined) {
            setAwaitingReply(false);
            streamedMessageId = append('agent', streamedText);
            setStreamingMessageId(streamedMessageId);
          } else {
            updateMessage(streamedMessageId, streamedText);
          }
        } else {
          result = event.result;
          setAwaitingReply(false);
          setStreamingMessageId(undefined);
        }
      }
    } catch (error) {
      append('agent', `运行出错：${error instanceof Error ? error.message : String(error)}`);
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
      append('agent', '检测到 cross-repo 任务，已在执行前暂停，等待确认计划。');
      return;
    }

    if (result.status === 'approval-required' && result.pendingApproval) {
      setStatus('approval-required');
      setPendingToolApproval(result.pendingApproval);
      setApprovalSelection('approve');
      append('agent', result.summary);
      return;
    }

    if (streamedMessageId !== undefined) {
      updateMessage(streamedMessageId, result.summary);
    } else {
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
    setPendingToolApproval(undefined);
    append('agent', approved ? '已批准工具调用，继续执行。' : '已拒绝工具调用，继续让模型调整方案。');

    let result: AgentResult;
    try {
      result = await agentRuntime.resolveToolApproval({
        runId: pendingToolApproval.runId,
        approved
      });
    } catch (error) {
      append('agent', `处理审批时出错：${error instanceof Error ? error.message : String(error)}`);
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
      append('agent', result.summary);
      return;
    }

    append('agent', result.summary);
    setAwaitingReply(false);
    setStatus('ready');
  }, [agentRuntime, append, pendingToolApproval]);

  useInput((inputKey, key) => {
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
        () => setRuntimeGeneration((current) => current + 1)
      )
    ) {
      return;
    }

    if (processingRef.current) {
      queueRef.current.push(trimmed);
      setQueueLength(queueRef.current.length);
      append('agent', `已加入队列：${queueRef.current.length}`);
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
    slashSuggestions
  ]);

  useEffect(() => {
    onReady?.({ submit, chooseToolApproval });
  }, [chooseToolApproval, onReady, submit]);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <HeaderBar
        projectName={projectName}
        mode={mode}
        status={status}
        queueLength={queueLength}
        permissionMode={permissionMode}
        runtimeError={runtimeError}
      />

      <SessionTip />

      <MessageList messages={messages} streamingMessageId={streamingMessageId} />

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
      />
    </Box>
  );
}

function createMemoryRuntime(): AgentRuntime {
  return new AgentRuntime({ traceStore: new InMemoryTraceStore() });
}

function handleCommand(
  value: string,
  append: (from: ChatMessage['from'], text: string) => void,
  setMode: (mode: AgentMode) => void,
  setPermissionMode: (mode: PermissionMode) => void,
  runtime: AgentRuntime,
  mode: AgentMode,
  importPrompt: ConfigImportPrompt | undefined,
  configImportController: ConfigImportController | undefined,
  setImportPrompt: (prompt: ConfigImportPrompt | undefined) => void,
  refreshRuntime: () => void
): boolean {
  if (!value.startsWith('/')) {
    return false;
  }

  if (value === '/help') {
    append('agent', formatSlashHelp());
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
      )
    );
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
      append('agent', `已切换到 ${nextMode} 模式`);
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
      append('agent', `已切换权限模式：${nextPerm}`);
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
  append: (from: ChatMessage['from'], text: string) => void;
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
      ].join('\n')
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
