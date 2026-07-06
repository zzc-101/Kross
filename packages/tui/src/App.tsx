import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

import {
  AgentRuntime,
  type AgentMode,
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
  initialMode?: AgentMode;
  projectName?: string;
  onReady?: (api: AppTestApi) => void;
}

export interface AppTestApi {
  submit: (value: string) => Promise<void>;
}

export function App({
  runtime,
  initialMode = 'auto',
  projectName = 'local',
  onReady
}: AppProps) {
  const agentRuntime = useMemo(() => runtime ?? createMemoryRuntime(), [runtime]);
  const [mode, setMode] = useState<AgentMode>(initialMode);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('ready');
  const [queueLength, setQueueLength] = useState(0);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 1,
      from: 'agent',
      text: 'Welcome. 输入任务，或输入 /help 查看命令。'
    }
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

    append('agent', result.summary);
    setStatus('ready');
  }, [agentRuntime, append, mode]);

  const submit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }

    setInput('');
    append('user', `> ${trimmed}`);

    if (handleCommand(trimmed, append, setMode)) {
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
  }, [append, runTurn]);

  useEffect(() => {
    onReady?.({ submit });
  }, [onReady, submit]);

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
        <Text dimColor>/help for help, /status for setup, /mode to switch mode</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Tip: 用自然语言描述任务；跨仓库任务会先暂停等待确认。</Text>
        <Text dimColor> </Text>
        {messages.map((message) => (
          <MessageLine key={message.id} message={message} />
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>/help  /mode auto|normal|cross-repo  /trace  /diff</Text>
      </Box>

      <Box>
        <Text>{'> '}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} />
      </Box>
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
  setMode: (mode: AgentMode) => void
): boolean {
  if (!value.startsWith('/')) {
    return false;
  }

  if (value === '/help') {
    append(
      'agent',
      '可用命令：/mode auto|normal|cross-repo，/trace，/diff，/help，/status'
    );
    return true;
  }

  if (value === '/status') {
    append('agent', '当前运行在本地 TUI。模型、trace 和 registry 状态会在后续版本展开。');
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

class InMemoryTraceStore implements TraceStore {
  private readonly events: TraceEvent[] = [];

  async append(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }
}
