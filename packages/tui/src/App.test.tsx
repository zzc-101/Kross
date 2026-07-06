import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { App } from './App';
import {
  AgentRuntime,
  createConfigImportController,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamChunk,
  type TraceEvent,
  type TraceStore,
  ToolGateway
} from '@kross/core';
import { z } from 'zod';

describe('App', () => {
  it('renders a Claude Code style full-width chat shell', () => {
    const { lastFrame } = render(<App />);

    expect(lastFrame()).toContain('Kross');
    expect(lastFrame()).toContain('Welcome');
    expect(lastFrame()).toContain('mode: auto');
    expect(lastFrame()).toContain('/help');
    expect(lastFrame()).toContain('>');
    expect(lastFrame()).not.toContain('Task Tree');
    expect(lastFrame()).not.toContain('Conversation');
  });

  it('shows a submitted message in conversation history', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const { lastFrame } = render(<App onReady={(api) => (submit = api.submit)} />);

    await waitUntil(() => submit !== undefined);
    await submit?.('给巡检任务增加任务来源字段');
    await waitUntil(() => lastFrame()?.includes('> 给巡检任务增加任务来源字段') === true);

    expect(lastFrame()).toContain('> 给巡检任务增加任务来源字段');
  });

  it('responds with LLM text and returns to waiting input', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('你好，我在。')
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('nihao');
    await waitUntil(() => lastFrame()?.includes('你好，我在。') === true);

    expect(lastFrame()).toContain('status: ready');
    expect(lastFrame()).toContain('Agent');
    expect(lastFrame()).toContain('你好，我在。');
  });

  it('shows model configuration guidance instead of fake completion text', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const { lastFrame } = render(<App onReady={(api) => (submit = api.submit)} />);

    await waitUntil(() => submit !== undefined);
    await submit?.('nihao');
    await waitUntil(() => lastFrame()?.includes('未配置模型') === true);

    expect(lastFrame()).toContain('未配置模型');
    expect(lastFrame()).not.toContain('最小规划闭环');
  });

  it('shows usage for incomplete slash commands', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const { lastFrame } = render(<App onReady={(api) => (submit = api.submit)} />);

    await waitUntil(() => submit !== undefined);
    await submit?.('/mode');

    expect(lastFrame()).toContain('用法：/mode auto|normal|cross-repo');
    expect(lastFrame()).not.toContain('最小规划闭环');
  });

  it('queues messages submitted while a response is running', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const llmClient = new DelayedLlmClient();
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    const first = submit?.('first');
    await waitUntil(() => llmClient.requests.length === 1);
    await submit?.('second');

    expect(lastFrame()).toContain('队列：1');

    llmClient.resolveNext('first done');
    await waitUntil(() => llmClient.requests.length === 2);
    llmClient.resolveNext('second done');
    await first;
    await waitUntil(() => lastFrame()?.includes('second done') === true);

    expect(lastFrame()).toContain('first done');
    expect(lastFrame()).toContain('second done');
  });

  it('shows cross-repo approval status for linkage requests', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const { lastFrame } = render(<App onReady={(api) => (submit = api.submit)} />);

    await waitUntil(() => submit !== undefined);
    await submit?.('给巡检任务增加任务来源字段，前后端联动');
    await waitUntil(() => lastFrame()?.includes('等待确认') === true);

    expect(lastFrame()).toContain('cross-repo');
    expect(lastFrame()).toContain('等待确认');
  });

  it('shows current context status with /context', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('第一轮回复')
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('第一轮');
    await waitUntil(() => lastFrame()?.includes('第一轮回复') === true);
    await submit?.('/context');

    expect(lastFrame()).toContain('Context');
    expect(lastFrame()).toContain('总字符');
    expect(lastFrame()).toContain('history');
    expect(lastFrame()).toContain('contributors');
  });

  it('prompts to import Claude Code or Codex config on first launch and saves the chosen config', async () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.codex'), { recursive: true });
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      writeFileSync(
        join(homeDir, '.codex/config.toml'),
        [
          'model = "gpt-5-codex"',
          '',
          '[model_providers.openai]',
          'base_url = "https://codex.example/v1"'
        ].join('\n')
      );
      writeFileSync(
        join(homeDir, '.claude/settings.json'),
        JSON.stringify({ model: 'claude-sonnet-4-5' })
      );
      let submit: ((value: string) => Promise<void>) | undefined;
      const { lastFrame } = render(
        <App
          configImportController={createConfigImportController({
            homeDir,
            env: {
              OPENAI_API_KEY: 'codex-key',
              ANTHROPIC_API_KEY: 'claude-key'
            },
            pathEnv: ''
          })}
          onReady={(api) => (submit = api.submit)}
        />
      );

      await waitUntil(() => submit !== undefined);
      expect(lastFrame()).toContain('检测到 Claude Code 和 Codex 配置');
      expect(lastFrame()).toContain('/import claude');
      expect(lastFrame()).toContain('/import codex');

      await submit?.('/import codex');

      expect(lastFrame()).toContain('已导入 Codex 配置');
      expect(
        JSON.parse(readFileSync(join(homeDir, '.kross/config.json'), 'utf8'))
      ).toMatchObject({
        llm: {
          provider: 'openai',
          apiKey: 'codex-key',
          model: 'gpt-5-codex',
          baseUrl: 'https://codex.example/v1'
        },
        setup: {
          importedFrom: 'codex'
        }
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('can skip the first-launch config import prompt', async () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.codex'), { recursive: true });
      writeFileSync(join(homeDir, '.codex/config.toml'), 'model = "gpt-5-codex"\n');
      let submit: ((value: string) => Promise<void>) | undefined;
      const { lastFrame } = render(
        <App
          configImportController={createConfigImportController({
            homeDir,
            env: { OPENAI_API_KEY: 'codex-key' },
            pathEnv: ''
          })}
          onReady={(api) => (submit = api.submit)}
        />
      );

      await waitUntil(() => submit !== undefined);
      expect(lastFrame()).toContain('/import codex');

      await submit?.('/import skip');

      expect(lastFrame()).toContain('已跳过配置导入');
      expect(
        JSON.parse(readFileSync(join(homeDir, '.kross/config.json'), 'utf8'))
      ).toMatchObject({
        setup: {
          importPromptDismissedAt: expect.any(String)
        }
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('shows selectable approval options for risky tool calls and resumes after approval', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    let chooseToolApproval: ((approved: boolean) => Promise<void>) | undefined;
    const llmClient = new WriteToolCallingLlmClient();
    const toolGateway = new ToolGateway({ traceStore: new InMemoryTraceStore() });
    toolGateway.register({
      name: 'fs.write',
      description: '写文件',
      risk: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ input }) => ({ content: `wrote ${input.path}` })
    });
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient,
      toolGateway
    });
    const { lastFrame } = render(
      <App
        runtime={runtime}
        onReady={(api) => {
          submit = api.submit;
          chooseToolApproval = api.chooseToolApproval;
        }}
      />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('写 README');
    await waitUntil(() => lastFrame()?.includes('需要确认工具调用') === true);

    expect(lastFrame()).toContain('fs.write');
    expect(lastFrame()).toContain('Approve');
    expect(lastFrame()).toContain('Reject');
    expect(lastFrame()).not.toContain('/approve');

    await chooseToolApproval?.(true);
    await waitUntil(() => lastFrame()?.includes('写入完成') === true);

    expect(lastFrame()).toContain('status: ready');
    expect(lastFrame()).toContain('写入完成');
  });
});

class InMemoryTraceStore implements TraceStore {
  readonly events: TraceEvent[] = [];

  async append(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }
}

class FakeLlmClient implements LlmClient {
  readonly provider = 'openai' as const;

  constructor(private readonly text: string) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    return {
      provider: this.provider,
      model: request.model ?? 'fake-model',
      text: this.text,
      raw: {}
    };
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
  }
}

class DelayedLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];
  private readonly resolvers: Array<(value: LlmResponse) => void> = [];

  complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  resolveNext(text: string): void {
    const resolve = this.resolvers.shift();
    resolve?.({
      provider: this.provider,
      model: 'fake-model',
      text,
      raw: {}
    });
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
  }
}

class WriteToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [
          {
            id: 'write-1',
            name: 'fs.write',
            input: { path: 'README.md', content: 'hello' }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '写入完成',
      raw: {}
    };
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'kross-tui-home-'));
}
