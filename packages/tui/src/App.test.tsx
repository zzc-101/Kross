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
  ObservableTraceStore,
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
    expect(lastFrame()).toContain('准备就绪');
    expect(lastFrame()).toContain('auto');
    expect(lastFrame()).toContain('ready');
    expect(lastFrame()).toContain('perm: default');
    expect(lastFrame()).toContain('/help');
    expect(lastFrame()).toContain('❯');
    // 输入框右下角：模型 · 权限模式
    expect(lastFrame()).toContain('no model');
    expect(lastFrame()).toContain('default');
    expect(lastFrame()).not.toContain('Task Tree');
    expect(lastFrame()).not.toContain('Conversation');
  });

  it('shows configured model and permission label in the composer footer', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('ok')
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    expect(lastFrame()).toContain('fake-model');
    expect(lastFrame()).toContain('default');

    await submit?.('/perm auto');
    await waitUntil(() => lastFrame()?.includes('always-approve') === true);
    expect(lastFrame()).toContain('fake-model · always-approve');
  });

  it('shows a submitted message in conversation history', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const { lastFrame } = render(<App onReady={(api) => (submit = api.submit)} />);

    await waitUntil(() => submit !== undefined);
    await submit?.('给巡检任务增加任务来源字段');
    await waitUntil(() => lastFrame()?.includes('给巡检任务增加任务来源字段') === true);

    expect(lastFrame()).toContain('you');
    expect(lastFrame()).toContain('给巡检任务增加任务来源字段');
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

    expect(lastFrame()).toContain('ready');
    expect(lastFrame()).toContain('kross');
    expect(lastFrame()).toContain('你好，我在。');
  });

  it('renders streaming deltas before the final response completes', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const llmClient = new ControlledStreamingLlmClient();
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    const submission = submit?.('nihao');

    await waitUntil(() => lastFrame()?.includes('流') === true);
    expect(lastFrame()).toContain('流');
    expect(lastFrame()).not.toContain('流式完成');

    llmClient.releaseFinalChunk();
    await submission;
    await waitUntil(() => lastFrame()?.includes('流式完成') === true);

    expect(lastFrame()).toContain('ready');
    expect(lastFrame()).toContain('流式完成');
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

  it('does not collapse long agent replies', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const longReply = Array.from({ length: 16 }, (_, index) => `detail-line-${index}`).join(
      '\n'
    );
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient(longReply)
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('长回复');
    await waitUntil(() => lastFrame()?.includes('detail-line-15') === true);

    expect(lastFrame()).toContain('detail-line-0');
    expect(lastFrame()).toContain('detail-line-15');
    expect(lastFrame()).not.toContain('已折叠');
  });

  it('streams thinking separately and toggles its collapse with ctrl+o', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    let toggleCollapse: (() => void) | undefined;
    const longThinking = Array.from({ length: 16 }, (_, index) => `think-line-${index}`).join(
      '\n'
    );
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new ThinkingLlmClient(longThinking, '最终结论')
    });
    const { lastFrame } = render(
      <App
        runtime={runtime}
        onReady={(api) => {
          submit = api.submit;
          toggleCollapse = api.toggleCollapse;
        }}
      />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('带思考');
    await waitUntil(() => lastFrame()?.includes('最终结论') === true);

    expect(lastFrame()).toContain('thinking');
    expect(lastFrame()).toContain('think-line-0');
    expect(lastFrame()).toContain('已折叠 thinking');
    expect(lastFrame()).not.toContain('think-line-15');
    expect(lastFrame()).toContain('最终结论');

    toggleCollapse?.();
    await waitUntil(() => lastFrame()?.includes('think-line-15') === true);
    expect(lastFrame()).toContain('thinking 已展开');

    toggleCollapse?.();
    await waitUntil(() => lastFrame()?.includes('已折叠 thinking') === true);
    expect(lastFrame()).not.toContain('think-line-15');
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

  it('can explicitly reimport config when the first-launch prompt is hidden', async () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.kross'), { recursive: true });
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      writeFileSync(
        join(homeDir, '.kross/config.json'),
        JSON.stringify({
          llm: {
            provider: 'openai',
            apiKey: 'old-key',
            model: 'old-model'
          }
        })
      );
      writeFileSync(
        join(homeDir, '.claude/settings.json'),
        JSON.stringify({
          model: 'sonnet',
          env: {
            ANTHROPIC_AUTH_TOKEN: 'claude-token',
            ANTHROPIC_MODEL: 'GLM-4.5',
            ANTHROPIC_BASE_URL: 'https://ark.example/api/coding'
          }
        })
      );
      let submit: ((value: string) => Promise<void>) | undefined;
      const { lastFrame } = render(
        <App
          configImportController={createConfigImportController({
            homeDir,
            env: {},
            pathEnv: ''
          })}
          onReady={(api) => (submit = api.submit)}
        />
      );

      await waitUntil(() => submit !== undefined);
      expect(lastFrame()).not.toContain('请选择一个导入');

      await submit?.('/import claude');

      expect(lastFrame()).toContain('已导入 Claude Code 配置');
      expect(lastFrame()).toContain('credential: 已配置');
      expect(
        JSON.parse(readFileSync(join(homeDir, '.kross/config.json'), 'utf8'))
      ).toMatchObject({
        llm: {
          provider: 'anthropic',
          authToken: 'claude-token',
          model: 'GLM-4.5',
          baseUrl: 'https://ark.example/api/coding'
        },
        setup: {
          importedFrom: 'claude'
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

  it('keeps thinking/tool/text as separate bubbles across multi-turn tool loops', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const llmClient = new MultiTurnThinkingToolClient();
    const traceStore = new ObservableTraceStore(new InMemoryTraceStore());
    const toolGateway = new ToolGateway({
      traceStore,
      approvalPolicy: () => ({ action: 'allow' })
    });
    toolGateway.register({
      name: 'Read',
      description: '读文件',
      risk: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ input }) => ({ content: `content of ${input.path}` })
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      toolGateway
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('读文件并总结');
    await waitUntil(() => lastFrame()?.includes('最终总结') === true);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
    expect(frame).toContain('先看看文件');
    expect(frame).toContain('Read');
    expect(frame).toContain('done');
    expect(frame).toContain('最终总结');
    // 第二轮 thinking 也是独立块
    expect(frame).toContain('根据内容总结');
    // 工具前的 thinking 不应被最终总结覆盖掉
    expect(frame.indexOf('先看看文件')).toBeLessThan(frame.indexOf('Read'));
    expect(frame.indexOf('Read')).toBeLessThan(frame.indexOf('最终总结'));
  });

  it('shows thinking after tool approval when follow-up returns reasoning', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    let chooseToolApproval: ((approved: boolean) => Promise<void>) | undefined;
    const llmClient = new WriteToolCallingLlmClient({
      delayFollowup: false,
      thinking: '审批后继续思考',
      finalText: '写入完成'
    });
    const traceStore = new ObservableTraceStore(new InMemoryTraceStore());
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'fs.write',
      description: '写文件',
      risk: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ input }) => ({ content: `wrote ${input.path}` })
    });
    const runtime = new AgentRuntime({
      traceStore,
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
    expect(lastFrame()).toContain('awaiting');

    await chooseToolApproval?.(true);
    await waitUntil(() => lastFrame()?.includes('写入完成') === true);
    expect(lastFrame()).toContain('thinking');
    expect(lastFrame()).toContain('审批后继续思考');
    expect(lastFrame()).toContain('写入完成');
  });

  it('renders live tool call cards while tools run', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const llmClient = new ReadToolCallingLlmClient();
    const traceStore = new ObservableTraceStore(new InMemoryTraceStore());
    const toolGateway = new ToolGateway({
      traceStore,
      approvalPolicy: () => ({ action: 'allow' })
    });
    toolGateway.register({
      name: 'Read',
      description: '读文件',
      risk: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ input }) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { content: `content of ${input.path}` };
      }
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      toolGateway
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    const done = submit?.('读一下文件');
    await waitUntil(() => lastFrame()?.includes('Read') === true);
    expect(lastFrame()).toMatch(/running|done/);

    await done;
    await waitUntil(() => lastFrame()?.includes('done') === true);
    expect(lastFrame()).toContain('Read');
    expect(lastFrame()).toContain('README.md');
    expect(lastFrame()).toContain('读完了');
  });

  it(
    'shows selectable approval options for risky tool calls and resumes after approval',
    async () => {
      let submit: ((value: string) => Promise<void>) | undefined;
      let chooseToolApproval: ((approved: boolean) => Promise<void>) | undefined;
      const llmClient = new WriteToolCallingLlmClient({ delayFollowup: true });
      const traceStore = new ObservableTraceStore(new InMemoryTraceStore());
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.write',
        description: '写文件',
        risk: 'write',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ input }) => ({ content: `wrote ${input.path}` })
      });
      const runtime = new AgentRuntime({
        traceStore,
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
      expect(lastFrame()).toContain('╭');
      expect(lastFrame()).not.toContain('/approve');

      const approval = chooseToolApproval?.(true);
      await waitUntil(() => lastFrame()?.includes('working') === true);
      expect(lastFrame()).toContain('已批准工具调用');

      llmClient.releaseFollowup();
      await approval;
      await waitUntil(() => lastFrame()?.includes('写入完成') === true);

      expect(lastFrame()).toContain('ready');
      expect(lastFrame()).toContain('写入完成');
    },
    15_000
  );

  it('cycles permission modes with /perm and reflects them in the header', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const toolGateway = new ToolGateway({ traceStore: new InMemoryTraceStore() });
    toolGateway.register({
      name: 'Write',
      description: '写文件',
      risk: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ input }) => ({ content: `wrote ${input.path}` })
    });
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      toolGateway
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    expect(lastFrame()).toContain('perm: default');

    await submit?.('/perm classifier');
    await waitUntil(() => lastFrame()?.includes('perm: classifier') === true);
    expect(runtime.getPermissionMode()).toBe('classifier');

    await submit?.('/perm auto');
    await waitUntil(() => lastFrame()?.includes('perm: auto') === true);
    expect(runtime.getPermissionMode()).toBe('auto');
  });

  it('shows slash command suggestions while typing a prefix', async () => {
    let setInput: ((value: string) => void) | undefined;
    const { lastFrame } = render(
      <App onReady={(api) => (setInput = api.setInput)} />
    );

    await waitUntil(() => setInput !== undefined);
    setInput?.('/');
    await waitUntil(() => lastFrame()?.includes('查看可用命令') === true);
    expect(lastFrame()).toContain('commands');
    expect(lastFrame()).toContain('/help');

    setInput?.('/mo');
    await waitUntil(() => lastFrame()?.includes('切换 agent 模式') === true);
    expect(lastFrame()).toContain('/mode');
    expect(lastFrame()).not.toContain('/import');
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
  readonly model = 'fake-model';

  constructor(private readonly text: string) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    return {
      provider: this.provider,
      model: request.model ?? this.model,
      text: this.text,
      raw: {}
    };
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'text-delta', text: this.text };
    yield { type: 'done' };
  }
}

class ThinkingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;

  constructor(
    private readonly thinking: string,
    private readonly text: string
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    return {
      provider: this.provider,
      model: request.model ?? 'fake-model',
      text: this.text,
      thinking: this.thinking,
      raw: {}
    };
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'thinking-delta', text: this.thinking };
    yield { type: 'text-delta', text: this.text };
    yield { type: 'done' };
  }
}

class ControlledStreamingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  private release: (() => void) | undefined;

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'text-delta', text: '流' };
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    yield { type: 'text-delta', text: '式完成' };
    yield { type: 'done' };
  }

  releaseFinalChunk(): void {
    this.release?.();
  }
}

class DelayedLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];
  private readonly resolvers: Array<(value: string) => void> = [];

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  resolveNext(text: string): void {
    const resolve = this.resolvers.shift();
    resolve?.(text);
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    const text = await new Promise<string>((resolve) => {
      this.resolvers.push(resolve);
    });
    yield { type: 'text-delta', text };
    yield { type: 'done' };
  }
}

class ReadToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  private phase: 'tool' | 'final' = 'tool';

  async complete(request: LlmRequest): Promise<LlmResponse> {
    return {
      provider: this.provider,
      model: 'fake-model',
      text: '读完了',
      raw: {}
    };
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    if (this.phase === 'tool') {
      this.phase = 'final';
      yield {
        type: 'tool-call',
        call: {
          id: 'read-1',
          name: 'Read',
          input: { path: 'README.md' }
        }
      };
      yield { type: 'done' };
      return;
    }

    yield { type: 'text-delta', text: '读完了' };
    yield { type: 'done' };
  }
}

class MultiTurnThinkingToolClient implements LlmClient {
  readonly provider = 'openai' as const;
  private phase: 'tool' | 'final' = 'tool';

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    if (this.phase === 'tool') {
      this.phase = 'final';
      yield { type: 'thinking-delta', text: '先看看文件' };
      yield {
        type: 'tool-call',
        call: { id: 'read-1', name: 'Read', input: { path: 'README.md' } }
      };
      yield { type: 'done' };
      return;
    }

    yield { type: 'thinking-delta', text: '根据内容总结' };
    yield { type: 'text-delta', text: '最终总结' };
    yield { type: 'done' };
  }
}

class WriteToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];
  private readonly delayFollowup: boolean;
  private readonly thinking: string | undefined;
  private readonly finalText: string;
  private release: (() => void) | undefined;
  private followupReleased = false;

  constructor(
    options: { delayFollowup?: boolean; thinking?: string; finalText?: string } = {}
  ) {
    this.delayFollowup = options.delayFollowup === true;
    this.thinking = options.thinking;
    this.finalText = options.finalText ?? '写入完成';
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    // 允许 releaseFollowup 抢跑：若测试先 release，complete 不再阻塞。
    if (this.delayFollowup && this.requests.length > 1 && !this.followupReleased) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return {
      provider: this.provider,
      model: 'fake-model',
      text: this.finalText,
      thinking: this.thinking,
      raw: {}
    };
  }

  releaseFollowup(): void {
    this.followupReleased = true;
    this.release?.();
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: 'tool-call',
        call: {
          id: 'write-1',
          name: 'fs.write',
          input: { path: 'README.md', content: 'hello' }
        }
      };
      yield { type: 'done' };
      return;
    }

    if (this.thinking) {
      yield { type: 'thinking-delta', text: this.thinking };
    }
    yield { type: 'text-delta', text: this.finalText };
    yield { type: 'done' };
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitUntil timed out');
}

function createTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'kross-tui-home-'));
}
