import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

import {
  AgentRuntime,
  type AgentMode,
  type ConfigImportController,
  type ConfigImportPrompt,
  type ContextInspection,
  type ExternalAgentSource,
  type PendingToolApproval,
  type TraceEvent,
  type TraceStore
} from '@kross/core';

interface Message {
  id: number;
  from: 'user' | 'agent';
  text: string;
}

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
  const agentRuntime = useMemo(
    () => runtime ?? createRuntime?.() ?? createMemoryRuntime(),
    [createRuntime, runtime, runtimeGeneration]
  );
  const [importPrompt, setImportPrompt] = useState<ConfigImportPrompt | undefined>(
    initialImportPrompt
  );
  const [mode, setMode] = useState<AgentMode>(initialMode);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('ready');
  const [queueLength, setQueueLength] = useState(0);
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | undefined>();
  const [approvalSelection, setApprovalSelection] = useState<'approve' | 'reject'>('approve');
  const [messages, setMessages] = useState<Message[]>(() => [
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
  const processingRef = useRef(false);
  const queueRef = useRef<string[]>([]);

  const append = useCallback((from: Message['from'], text: string) => {
    setMessages((current) => [
      ...current,
      {
        id: current.length + 1,
        from,
        text
      }
    ]);
  }, []);

  const runTurn = useCallback(async (prompt: string) => {
    setStatus('responding');
    const result = await agentRuntime.run({
      input: prompt,
      requestedMode: mode,
      approvals: { plan: false }
    });

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

    append('agent', result.summary);
    setStatus('ready');
  }, [agentRuntime, append, mode]);

  const chooseToolApproval = useCallback(async (approved: boolean) => {
    if (!pendingToolApproval) {
      return;
    }

    setStatus('responding');
    const result = await agentRuntime.resolveToolApproval({
      runId: pendingToolApproval.runId,
      approved
    });
    setPendingToolApproval(undefined);
    append('agent', approved ? '已批准工具调用，继续执行。' : '已拒绝工具调用，继续让模型调整方案。');
    append('agent', result.summary);
    setStatus('ready');
  }, [agentRuntime, append, pendingToolApproval]);

  useInput((inputKey, key) => {
    if (!pendingToolApproval) {
      return;
    }

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
  });

  const submit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }

    setInput('');
    append('user', `> ${trimmed}`);

    if (
      handleCommand(
        trimmed,
        append,
        setMode,
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
    runTurn
  ]);

  useEffect(() => {
    onReady?.({ submit, chooseToolApproval });
  }, [chooseToolApproval, onReady, submit]);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" flexDirection="column" paddingX={1}>
        <Text>
          <Text bold>Kross</Text>
          <Text> v0.1.0</Text>
        </Text>
        <Text>
          Welcome | project: {projectName} | mode: {mode} | status: {status}
          {queueLength > 0 ? ` | 队列：${queueLength}` : ''}
        </Text>
        <Text dimColor>/help for help, /context for context, /mode to switch mode</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Tip: 用自然语言描述任务；跨仓库任务会先暂停等待确认。</Text>
        <Text dimColor> </Text>
        {messages.map((message) => (
          <MessageLine key={message.id} message={message} />
        ))}
        {pendingToolApproval ? (
          <ApprovalPanel
            approval={pendingToolApproval}
            selection={approvalSelection}
          />
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>/help  /context  /mode auto|normal|cross-repo  /trace  /diff</Text>
      </Box>

      {pendingToolApproval ? null : (
        <Box>
          <Text>{'> '}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} />
        </Box>
      )}
    </Box>
  );
}

function ApprovalPanel({
  approval,
  selection
}: {
  approval: PendingToolApproval;
  selection: 'approve' | 'reject';
}) {
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>需要确认工具调用</Text>
      <Text>tool: {approval.toolName}</Text>
      <Text>risk: {approval.risk}</Text>
      <Text>input: {approval.inputPreview}</Text>
      {approval.reason ? <Text>reason: {approval.reason}</Text> : null}
      <Box marginTop={1}>
        <Text color={selection === 'approve' ? 'green' : undefined}>
          {selection === 'approve' ? '❯ ' : '  '}Approve
        </Text>
        <Text>  </Text>
        <Text color={selection === 'reject' ? 'red' : undefined}>
          {selection === 'reject' ? '❯ ' : '  '}Reject
        </Text>
      </Box>
      <Text dimColor>←/→ 切换，Enter 确认；也可按 a/r。</Text>
    </Box>
  );
}

function MessageLine({ message }: { message: Message }) {
  if (message.from === 'user') {
    return <Text>{message.text}</Text>;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>
        Agent
      </Text>
      {message.text.split('\n').map((line, index) => (
        <Text key={`${message.id}-${index}`} color="cyan">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function createMemoryRuntime(): AgentRuntime {
  return new AgentRuntime({ traceStore: new InMemoryTraceStore() });
}

function handleCommand(
  value: string,
  append: (from: Message['from'], text: string) => void,
  setMode: (mode: AgentMode) => void,
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
    append(
      'agent',
      '可用命令：/context，/import claude|codex|skip，/mode auto|normal|cross-repo，/trace，/diff，/help，/status'
    );
    return true;
  }

  if (value === '/status') {
    append('agent', '当前运行在本地 TUI。模型、trace 和 registry 状态会在后续版本展开。');
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

  append('agent', `未知命令：${value}。输入 /help 查看可用命令。`);
  return true;
}

function isAgentMode(value: string): value is AgentMode {
  return value === 'auto' || value === 'normal' || value === 'cross-repo';
}

function handleImportCommand(input: {
  value: string;
  append: (from: Message['from'], text: string) => void;
  importPrompt: ConfigImportPrompt | undefined;
  configImportController: ConfigImportController | undefined;
  setImportPrompt: (prompt: ConfigImportPrompt | undefined) => void;
  refreshRuntime: () => void;
}): void {
  if (!input.configImportController || !input.importPrompt) {
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
        `baseUrl: ${result.config.llm?.baseUrl ?? '默认'}`
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

function formatImportUsage(prompt: ConfigImportPrompt): string {
  const commands = prompt.candidates
    .map((candidate) => `/import ${candidate.source}`)
    .join(' | ');
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
