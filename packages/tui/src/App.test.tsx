import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { App, type AppTestApi } from './App';
import {
  AgentRuntime,
  createConfigImportController,
  HybridSessionStore,
  ObservableTraceStore,
  SessionContext,
  type ContextMaintenanceResult,
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

    expect(lastFrame()).toContain('__ __  ____');
    // 新会话首页只保留三个主动作和一个上下文提示
    expect(lastFrame()).toContain('随时可以开始');
    expect(lastFrame()).toContain('输入内容开始新会话');
    expect(lastFrame()).toContain('查看命令');
    expect(lastFrame()).toContain('模型与思考强度');
    expect(lastFrame()).toContain('输入 / 查看全部命令');
    expect(lastFrame()).not.toContain('Thought');
    expect(lastFrame()).not.toContain('Expand tool details');
    expect(lastFrame()).toContain('❯');
    // 输入框右下角：模型 · 权限模式
    expect(lastFrame()).toContain('未配置模型');
    expect(lastFrame()).toContain('权限：默认');
    // 顶栏上下文占用 used/max
    expect(lastFrame()).toMatch(/\d+(\.\d+)?[KM]?\/\d+(\.\d+)?[KM]?/);
    expect(lastFrame()).not.toContain('Task Tree');
    expect(lastFrame()).not.toContain('Conversation');
  });

  it('accepts fullscreen prop without breaking non-TTY test render', () => {
    const { lastFrame } = render(<App fullscreen />);
    expect(lastFrame()).toContain('__ __  ____');
    expect(lastFrame()).toContain('❯');
    expect(lastFrame()).toContain('随时可以开始');
  });

  it('surfaces session store initialization failures instead of silently degrading', () => {
    const { lastFrame } = render(
      <App sessionStoreError="会话存储初始化失败，当前内容不会保存：native binding missing" />
    );

    expect(lastFrame()).toContain('会话存储初始化失败');
    expect(lastFrame()).toContain('当前内容不会保存');
  });

  it('flushes the session and delegates shutdown when Ctrl+C is pressed', async () => {
    const homeDir = createTempHome();
    const workspace = join(homeDir, 'workspace');
    mkdirSync(workspace);
    const sessionStore = new HybridSessionStore({
      krossHome: join(homeDir, '.kross'),
      createSessionId: () => 'session-ctrl-c-test'
    });
    const onExitRequest = vi.fn();
    let api: AppTestApi | undefined;
    const view = render(
      <App
        cwd={workspace}
        sessionStore={sessionStore}
        onExitRequest={onExitRequest}
        onReady={(next) => (api = next)}
      />
    );

    try {
      await waitUntil(() => api !== undefined);
      await api?.submit('退出前保存');
      api?.requestExit();
      expect(onExitRequest).toHaveBeenCalledTimes(1);

      expect(sessionStore.loadSession(workspace)?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: 'user', text: '> 退出前保存' })
        ])
      );
    } finally {
      view.unmount();
      sessionStore.close();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('leaves home screen after the first user message', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const { lastFrame } = render(
      <App
        branch="main"
        cwd="/Users/zc/MyProject/agent"
        onReady={(api) => (submit = api.submit)}
      />
    );

    await waitUntil(() => submit !== undefined);
    expect(lastFrame()).toContain('随时可以开始');
    expect(lastFrame()).toContain('main');
    expect(lastFrame()).toContain('~/MyProject/agent');
    // 路径只出现在顶栏，欢迎卡片内不再重复
    expect(lastFrame()?.split('~/MyProject/agent').length).toBe(2);

    await submit?.('hello task');
    await waitUntil(() => lastFrame()?.includes('hello task') === true);
    expect(lastFrame()).toContain('>');
    expect(lastFrame()).toContain('Todo · —');
    expect(lastFrame()).toContain('权限：默认');
    // 进入对话后仍显示 branch/cwd，而不是 projectName=local
    expect(lastFrame()).toContain('main');
    expect(lastFrame()).toContain('~/MyProject/agent');
    expect(lastFrame()).not.toContain('Kross · local');
  });

  it('shows recent sessions on home and restores visible records plus model context', async () => {
    const homeDir = createTempHome();
    const workspace = join(homeDir, 'workspace');
    mkdirSync(workspace);
    const sessionStore = new HybridSessionStore({
      krossHome: join(homeDir, '.kross'),
      createSessionId: () => 'session-resume-test'
    });
    const session = sessionStore.createSession(workspace);
    sessionStore.syncMessages(session.id, [
      { id: 1, from: 'user', text: '> 恢复这个产品会话' },
      { id: 2, from: 'thinking', text: '内部思考内容', durationMs: 800 },
      {
        id: 3,
        from: 'tool',
        text: 'Read README.md',
        tool: { name: 'Read', status: 'completed', summary: 'README.md' }
      },
      { id: 4, from: 'agent', text: '这是恢复后的回答' }
    ]);

    let api: AppTestApi | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('ok')
    });
    const view = render(
      <App
        runtime={runtime}
        cwd={workspace}
        sessionStore={sessionStore}
        onReady={(next) => (api = next)}
      />
    );

    try {
      await waitUntil(() => api !== undefined);
      expect(view.lastFrame()).toContain('KROSS');
      expect(view.lastFrame()).toContain('最近会话');
      expect(view.lastFrame()).toContain('恢复这个产品会话');
      expect(view.lastFrame()).toContain('↑↓ 选择');
      expect(view.lastFrame()).toContain('使用 ↑↓ 选择会话');
      expect(view.lastFrame()).not.toContain('Enter 恢复已选中会话');
      expect(view.lastFrame()).not.toContain('已选中');

      // 未明确选择时，空 Enter 不应隐式恢复会话。
      await api?.submit('');
      expect(view.lastFrame()).toContain('随时可以开始');

      // 用户明确选择后，界面给出恢复和取消提示。
      const initialApi = api;
      api?.setRecentSessionSelection(0);
      await waitUntil(
        () =>
          view.lastFrame()?.includes('Enter 恢复已选中会话') === true &&
          api !== initialApi
      );
      expect(view.lastFrame()).toContain('已选中 · Esc 取消');
      expect(view.lastFrame()).toContain('Esc 取消选择');
      expect(view.lastFrame()?.match(/已选中/g)).toHaveLength(2);

      // 取消后重新回到中立状态，不再允许空 Enter 恢复。
      const selectedApi = api;
      api?.setRecentSessionSelection(undefined);
      await waitUntil(
        () =>
          view.lastFrame()?.includes('Enter 恢复已选中会话') === false &&
          api !== selectedApi
      );
      expect(view.lastFrame()).toContain('↑↓ 选择');

      const deselectedApi = api;
      api?.setRecentSessionSelection(0);
      await waitUntil(
        () =>
          view.lastFrame()?.includes('Enter 恢复已选中会话') === true &&
          api !== deselectedApi
      );
      await api?.submit('');
      await waitUntil(() => view.lastFrame()?.includes('这是恢复后的回答') === true);
      expect(view.lastFrame()).toContain('Read');
      expect(view.lastFrame()).not.toContain('随时可以开始');

      const context = runtime.inspectContext({
        requestedMode: 'auto',
        currentUserInput: '继续'
      });
      const contextText = context.messages.map((message) => message.content).join('\n');
      expect(contextText).toContain('恢复这个产品会话');
      expect(contextText).toContain('这是恢复后的回答');
      expect(contextText).not.toContain('内部思考内容');
      expect(contextText).not.toContain('README.md');
    } finally {
      view.unmount();
      sessionStore.close();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('opens the session picker for bare /resume instead of loading the latest', async () => {
    const homeDir = createTempHome();
    const workspace = join(homeDir, 'workspace');
    mkdirSync(workspace);
    let sessionSeq = 0;
    const sessionStore = new HybridSessionStore({
      krossHome: join(homeDir, '.kross'),
      createSessionId: () => `session-picker-${sessionSeq++}`
    });
    const older = sessionStore.createSession(workspace);
    sessionStore.syncMessages(older.id, [
      { id: 1, from: 'user', text: '> 较早会话' },
      { id: 2, from: 'agent', text: '较早回复' }
    ]);
    const newer = sessionStore.createSession(workspace);
    sessionStore.syncMessages(newer.id, [
      { id: 1, from: 'user', text: '> 最近会话' },
      { id: 2, from: 'agent', text: '最近回复' }
    ]);

    let api: AppTestApi | undefined;
    const view = render(
      <App
        runtime={new AgentRuntime({
          traceStore: new InMemoryTraceStore(),
          llmClient: new FakeLlmClient('ok')
        })}
        cwd={workspace}
        sessionStore={sessionStore}
        onReady={(next) => (api = next)}
      />
    );

    try {
      await waitUntil(() => api !== undefined);
      await api?.submit('/resume');
      await waitUntil(
        () =>
          view.lastFrame()?.includes('Enter 恢复已选中会话') === true &&
          view.lastFrame()?.includes('最近会话') === true
      );
      // 未 Enter 前不应直接恢复最近一条的对话内容。
      expect(view.lastFrame()).toContain('随时可以开始');
      expect(view.lastFrame()).not.toContain('最近回复');
      expect(view.lastFrame()).toContain('已选中 · Esc 取消');

      await api?.submit('');
      await waitUntil(() => view.lastFrame()?.includes('最近回复') === true);
      expect(view.lastFrame()).not.toContain('随时可以开始');
    } finally {
      view.unmount();
      sessionStore.close();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('flushes the previous session before switching and does not pollute the target', async () => {
    const homeDir = createTempHome();
    const workspace = join(homeDir, 'workspace');
    mkdirSync(workspace);
    let sessionSeq = 0;
    const sessionStore = new HybridSessionStore({
      krossHome: join(homeDir, '.kross'),
      createSessionId: () => `session-switch-${sessionSeq++}`
    });
    const target = sessionStore.createSession(workspace);
    sessionStore.syncMessages(target.id, [
      { id: 1, from: 'user', text: '> 目标会话' },
      { id: 2, from: 'agent', text: '目标回复' }
    ]);

    let api: AppTestApi | undefined;
    const view = render(
      <App
        runtime={new AgentRuntime({
          traceStore: new InMemoryTraceStore(),
          llmClient: new FakeLlmClient('当前回复')
        })}
        cwd={workspace}
        sessionStore={sessionStore}
        onReady={(next) => (api = next)}
      />
    );

    try {
      await waitUntil(() => api !== undefined);
      await api?.submit('当前会话内容');
      await waitUntil(() => view.lastFrame()?.includes('当前回复') === true);

      const currentId = sessionStore.listRecent(workspace)[0]?.id;
      expect(currentId).toBeTruthy();
      expect(currentId).not.toBe(target.id);

      await api?.resumeSession(target.id);
      await waitUntil(() => view.lastFrame()?.includes('目标回复') === true);

      const targetRestored = sessionStore.loadSession(workspace, target.id);
      expect(targetRestored?.messages.map((message) => message.text)).toEqual([
        '> 目标会话',
        '目标回复'
      ]);
      expect(
        targetRestored?.messages.some((message) =>
          message.text.includes('当前会话内容')
        )
      ).toBe(false);

      const currentRestored = sessionStore.loadSession(workspace, currentId!);
      expect(
        currentRestored?.messages.some((message) =>
          message.text.includes('当前会话内容')
        )
      ).toBe(true);
    } finally {
      view.unmount();
      sessionStore.close();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('clears header token usage after resumeSession', async () => {
    const homeDir = createTempHome();
    const workspace = join(homeDir, 'workspace');
    mkdirSync(workspace);
    let sessionSeq = 0;
    const sessionStore = new HybridSessionStore({
      krossHome: join(homeDir, '.kross'),
      createSessionId: () => `session-usage-clear-${sessionSeq++}`
    });
    const target = sessionStore.createSession(workspace);
    sessionStore.syncMessages(target.id, [
      { id: 1, from: 'user', text: '> 恢复后会话' },
      { id: 2, from: 'agent', text: '恢复后回复' }
    ]);

    const llmClient = new FakeLlmClient('带 usage 的回复');
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient
    });
    let api: AppTestApi | undefined;
    const view = render(
      <App
        runtime={runtime}
        cwd={workspace}
        sessionStore={sessionStore}
        onReady={(next) => (api = next)}
      />
    );

    try {
      await waitUntil(() => api !== undefined);
      await api?.submit('先产生 token 占用');
      await waitUntil(() => view.lastFrame()?.includes('带 usage 的回复') === true);
      expect(runtime.getContextUsage({ requestedMode: 'auto' }).usedTokens).toBeGreaterThan(
        0
      );
      expect(runtime.getContextUsage({ requestedMode: 'auto' }).lastUsageTokens).toBe(
        37
      );

      await api?.resumeSession(target.id);
      await waitUntil(() => view.lastFrame()?.includes('恢复后回复') === true);
      expect(llmClient.lastUsage).toBeUndefined();
      expect(runtime.getContextUsage({ requestedMode: 'auto' }).lastUsageTokens).toBeUndefined();
      expect(runtime.getContextUsage({ requestedMode: 'auto' }).usedTokens).toBeGreaterThan(
        0
      );
    } finally {
      view.unmount();
      sessionStore.close();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('warns when a resumed context contains an interrupted open turn', async () => {
    const homeDir = createTempHome();
    const workspace = join(homeDir, 'workspace');
    mkdirSync(workspace);
    const sessionStore = new HybridSessionStore({
      krossHome: join(homeDir, '.kross'),
      createSessionId: () => 'session-interrupted-test'
    });
    const session = sessionStore.createSession(workspace);
    sessionStore.syncMessages(session.id, [
      { id: 1, from: 'user', text: '> 执行未完成任务' },
      { id: 2, from: 'agent', text: '等待工具结果' }
    ]);
    const context = new SessionContext();
    context.beginTurn('执行未完成任务');
    context.appendAssistant('等待工具结果', [
      { id: 'read-interrupted', name: 'Read', input: { path: 'README.md' } }
    ]);
    sessionStore.upsertContextState(session.id, context.exportState(), 2);

    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('ok')
    });
    let api: AppTestApi | undefined;
    const view = render(
      <App
        runtime={runtime}
        cwd={workspace}
        sessionStore={sessionStore}
        onReady={(next) => (api = next)}
      />
    );

    try {
      await waitUntil(() => api !== undefined);
      await api?.resumeSession(session.id);
      await waitUntil(
        () => view.lastFrame()?.includes('上次会话在未完成轮次中断') === true
      );

      const restored = runtime.inspectContext({
        requestedMode: 'auto',
        currentUserInput: '继续'
      });
      expect(restored.messages.map((message) => message.content).join('\n')).toContain(
        '上次会话在未完成轮次中断'
      );
      expect(
        restored.messages.some(
          (message) => message.role === 'assistant' && Boolean(message.toolCalls?.length)
        )
      ).toBe(false);
    } finally {
      view.unmount();
      sessionStore.close();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('creates and persists a session lazily after the first real prompt', async () => {
    const homeDir = createTempHome();
    const workspace = join(homeDir, 'workspace');
    mkdirSync(workspace);
    const sessionStore = new HybridSessionStore({
      krossHome: join(homeDir, '.kross'),
      createSessionId: () => 'session-lazy-test'
    });
    let submit: ((value: string) => Promise<void>) | undefined;
    const view = render(
      <App
        runtime={new AgentRuntime({
          traceStore: new InMemoryTraceStore(),
          llmClient: new FakeLlmClient('持久化回复')
        })}
        cwd={workspace}
        sessionStore={sessionStore}
        onReady={(api) => (submit = api.submit)}
      />
    );

    try {
      await waitUntil(() => submit !== undefined);
      expect(sessionStore.listRecent(workspace)).toEqual([]);

      await submit?.('把这轮保存下来');
      await waitUntil(() => view.lastFrame()?.includes('持久化回复') === true);

      const restored = sessionStore.loadSession(workspace);
      expect(restored?.summary.title).toBe('把这轮保存下来');
      expect(restored?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: 'user', text: '> 把这轮保存下来' }),
          expect.objectContaining({ from: 'agent', text: '持久化回复' })
        ])
      );
    } finally {
      view.unmount();
      sessionStore.close();
      rmSync(homeDir, { recursive: true, force: true });
    }
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
    expect(lastFrame()).toContain('权限：默认');
    expect(lastFrame()).toContain('0/256K');

    await submit?.('/perm auto');
    await waitUntil(() => lastFrame()?.includes('权限：自动允许') === true);
    expect(lastFrame()).toContain(
      'fake-model (medium) · 模式：自动 · 权限：自动允许'
    );
  });

  it('updates context usage from the latest API inputTokens', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('usage ok')
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('统计真实 token');
    await waitUntil(() => lastFrame()?.includes('37/256K') === true);
    expect(lastFrame()).toContain('usage ok');
  });

  it('refreshes composer model label after /model switch', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('ok')
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    expect(lastFrame()).toContain('fake-model (medium)');

    await submit?.('/model gpt-switched');
    await waitUntil(
      () => lastFrame()?.includes('gpt-switched (medium)') === true
    );
    expect(lastFrame()).toContain('gpt-switched (medium)');
    expect(runtime.getModelLabel()).toBe('gpt-switched (medium)');

    await submit?.('/model high');
    await waitUntil(() => lastFrame()?.includes('gpt-switched (high)') === true);
    expect(runtime.getModelLabel()).toBe('gpt-switched (high)');
    expect(runtime.getThinkingEffort()).toBe('high');
  });

  it('opens settings panel via /settings and bare /model', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('ok')
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('/settings');
    await waitUntil(() => lastFrame()?.includes('模型与思考强度') === true);
    expect(lastFrame()).toContain('ctrl+p');
    expect(lastFrame()).toContain('思考强度');

    // reopen via bare /model (after panel already open, submit still works)
    await submit?.('/model');
    await waitUntil(() => lastFrame()?.includes('模型与思考强度') === true);
  });

  it('shows a submitted message in conversation history', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const { lastFrame } = render(<App onReady={(api) => (submit = api.submit)} />);

    await waitUntil(() => submit !== undefined);
    await submit?.('给巡检任务增加任务来源字段');
    await waitUntil(() => lastFrame()?.includes('给巡检任务增加任务来源字段') === true);

    expect(lastFrame()).toContain('>');
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

    expect(lastFrame()).toContain('●');
    expect(lastFrame()).toContain('你好，我在。');
    expect(lastFrame()).toContain('权限：默认');
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

    expect(lastFrame()).toContain('用法：/mode auto|plan|conductor');
    expect(lastFrame()).toMatch(/当前模式：|Current mode:/);
    expect(lastFrame()).not.toContain('最小规划闭环');
  });

  it('lists recent traces and shows detail for /trace', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('trace 测试回复'),
      createRunId: () => 'run-ui-trace'
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('修复登录');
    await waitUntil(() => lastFrame()?.includes('trace 测试回复') === true);

    await submit?.('/trace');
    await waitUntil(() => lastFrame()?.includes('run-ui-trace') === true);
    expect(lastFrame()).toContain('修复登录');

    await submit?.('/trace run-ui-trace');
    await waitUntil(() => lastFrame()?.includes('Trace: run-ui-trace') === true);
    expect(lastFrame()).toContain('completed');
  });

  it('shows workspace diff summary for /diff', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('diff 测试回复'),
      createRunId: () => 'run-ui-diff',
      workspaceRoot: '/tmp/ws',
      runGit: async (args) => {
        if (args[0] === 'status') {
          return { stdout: ' M README.md\n', stderr: '' };
        }
        return { stdout: ' README.md | 1 +\n', stderr: '' };
      }
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('随便问一句');
    await waitUntil(() => lastFrame()?.includes('diff 测试回复') === true);

    await submit?.('/diff');
    await waitUntil(() => lastFrame()?.includes('run: run-ui-diff') === true);
    expect(lastFrame()).toContain('git status');
    expect(lastFrame()).toContain('M README.md');
    // hard-wrap may split "suggested verify" across rows with rail; match loosely
    expect(lastFrame()).toMatch(/suggested[\s\S]*verify/);
  });

  it('surfaces slash async failures instead of silent unhandled rejection', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('ok')
    });
    vi.spyOn(runtime, 'formatTraceCommand').mockRejectedValue(
      new Error('boom-trace')
    );
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('/trace');
    await waitUntil(() => lastFrame()?.includes('/trace 失败') === true);
    expect(lastFrame()).toContain('boom-trace');
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

  it('interrupts the active run with Esc and pauses queued messages', async () => {
    let api: AppTestApi | undefined;
    const llmClient = new DelayedLlmClient();
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient
    });
    const view = render(
      <App runtime={runtime} onReady={(next) => (api = next)} />
    );

    await waitUntil(() => api !== undefined);
    const first = api?.submit('first');
    await waitUntil(() => llmClient.requests.length === 1);
    await api?.submit('second');
    expect(view.lastFrame()).toContain('Esc 中断');

    expect(api?.interruptCurrentRun()).toBe(true);
    await first;
    await waitUntil(() => view.lastFrame()?.includes('已中断当前任务') === true);

    expect(llmClient.requests[0]?.signal?.aborted).toBe(true);
    expect(llmClient.requests).toHaveLength(1);
    expect(view.lastFrame()).toContain('队列：1');
    expect(view.lastFrame()).toContain('按 Enter 继续');
    expect(view.lastFrame()).not.toContain('运行出错');

    const resumed = api?.submit('');
    await waitUntil(() => llmClient.requests.length === 2);
    llmClient.resolveNext('second done');
    await resumed;
    await waitUntil(() => view.lastFrame()?.includes('second done') === true);
  });

  it('uses Esc to cancel a pending tool approval instead of rejecting it', async () => {
    let api: AppTestApi | undefined;
    const traceStore = new ObservableTraceStore(new InMemoryTraceStore());
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'fs.write',
      description: '写文件',
      risk: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({ content: 'written' })
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient: new WriteToolCallingLlmClient(),
      toolGateway
    });
    const view = render(
      <App runtime={runtime} onReady={(next) => (api = next)} />
    );

    await waitUntil(() => api !== undefined);
    await api?.submit('write a file');
    await waitUntil(() => view.lastFrame()?.includes('允许修改工作区') === true);

    expect(api?.interruptCurrentRun()).toBe(true);
    await waitUntil(() => view.lastFrame()?.includes('已中断当前任务') === true);

    expect(view.lastFrame()).not.toContain('允许修改工作区');
    expect(view.lastFrame()).not.toContain('已拒绝 fs.write');
  });

  it('shows conductor approval status for linkage requests', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const { lastFrame } = render(<App onReady={(api) => (submit = api.submit)} />);

    await waitUntil(() => submit !== undefined);
    await submit?.('/mode conductor');
    await submit?.('用指挥家拆任务并派 worker 执行');
    await waitUntil(() => lastFrame()?.includes('等待确认') === true);

    // Display uses i18n (指挥家), not raw mode id
    expect(lastFrame()).toMatch(/指挥家|Conductor/);
    expect(lastFrame()).toContain('等待确认');
  });

  it('can approve a paused conductor plan and continue the run', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    let choosePlanApproval: ((approved: boolean) => Promise<void>) | undefined;
    const { lastFrame } = render(
      <App
        onReady={(api) => {
          submit = api.submit;
          choosePlanApproval = (api as any).choosePlanApproval;
        }}
      />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('/mode conductor');
    await submit?.('用指挥家拆任务并派 worker 执行');
    await waitUntil(() => lastFrame()?.includes('等待确认') === true);

    expect(typeof choosePlanApproval).toBe('function');
    await choosePlanApproval?.(true);
    await waitUntil(
      () =>
        lastFrame()?.includes('指挥家执行完成') === true ||
        lastFrame()?.includes('memory subagent') === true ||
        lastFrame()?.includes('验收') === true
    );

    const frame = lastFrame() ?? '';
    expect(
      frame.includes('指挥家执行完成') ||
        frame.includes('memory subagent') ||
        frame.includes('验收')
    ).toBe(true);
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

    // 默认收拢为中文耗时摘要
    expect(lastFrame()).toMatch(/思考了 \d+ 秒/);
    expect(lastFrame()).not.toContain('think-line-15');
    expect(lastFrame()).toContain('最终结论');
    expect(lastFrame()).toContain('●');

    toggleCollapse?.();
    await waitUntil(() => lastFrame()?.includes('think-line-15') === true);
    expect(lastFrame()).toMatch(/思考了 \d+ 秒/);

    toggleCollapse?.();
    await waitUntil(() => lastFrame()?.includes('think-line-15') !== true);
    expect(lastFrame()).toMatch(/思考了 \d+ 秒/);
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
    expect(lastFrame()).toContain('预估 token');
    expect(lastFrame()).toContain('sections (tokens)');
    expect(lastFrame()).toContain('thread');
    expect(lastFrame()).toContain('最近治理');
  });

  it('serializes /compact with queued prompts and shows progress', async () => {
    let api: AppTestApi | undefined;
    let resolveCompact: ((result: ContextMaintenanceResult) => void) | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('压缩后回复')
    });
    const compactSpy = vi.spyOn(runtime, 'compactNow').mockImplementation(
      () =>
        new Promise<ContextMaintenanceResult>((resolve) => {
          resolveCompact = resolve;
        })
    );
    const runSpy = vi.spyOn(runtime, 'runStreaming');
    const view = render(
      <App runtime={runtime} onReady={(next) => (api = next)} />
    );

    await waitUntil(() => api !== undefined);
    const compactSubmission = api!.submit('/compact 保留架构决策');
    await waitUntil(() => compactSpy.mock.calls.length === 1);
    expect(view.lastFrame()).toContain('正在压缩上下文');
    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requestedMode: 'auto' }),
      '保留架构决策',
      expect.any(AbortSignal)
    );

    await api!.submit('压缩后继续');
    expect(runSpy).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('已加入队列');

    resolveCompact?.({
      compacted: false,
      reason: 'manual',
      droppedMessageCount: 0,
      preservedMessageCount: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      historyCharsBefore: 0,
      historyCharsAfter: 0
    });
    await compactSubmission;
    await waitUntil(() => view.lastFrame()?.includes('压缩后回复') === true);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(view.lastFrame()).toContain('压缩后继续');
  });

  it('interrupts an in-flight /compact command through the same Esc action', async () => {
    let api: AppTestApi | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('unused')
    });
    const compactSpy = vi.spyOn(runtime, 'compactNow').mockImplementation(
      async (_input, _instructions, signal) =>
        new Promise<ContextMaintenanceResult>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true
          });
        })
    );
    const runSpy = vi.spyOn(runtime, 'runStreaming');
    const view = render(
      <App runtime={runtime} onReady={(next) => (api = next)} />
    );

    await waitUntil(() => api !== undefined);
    const compacting = api?.submit('/compact');
    await waitUntil(() => compactSpy.mock.calls.length === 1);
    await api?.submit('压缩后继续');
    expect(api?.interruptCurrentRun()).toBe(true);
    await compacting;

    expect(view.lastFrame()).toContain('已中断当前任务');
    expect(view.lastFrame()).toContain('按 Enter 继续');
    expect(view.lastFrame()).not.toContain('/compact 失败');
    expect(runSpy).not.toHaveBeenCalled();

    await api?.submit('');
    expect(runSpy).toHaveBeenCalledTimes(1);
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
    // thinking 默认收拢为耗时摘要（Claude Code 式：结束后才落 Thought）
    expect(frame).toMatch(/思考了 \d+ 秒/);
    expect(frame).not.toMatch(/思考中/);
    expect(frame).toMatch(/Read/);
    expect(frame).toContain('最终总结');
    expect(frame).toContain('●');
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
    await waitUntil(() => lastFrame()?.includes('允许修改工作区？') === true);
    expect(lastFrame()).toContain('允许修改工作区？');

    await chooseToolApproval?.(true);
    await waitUntil(() => lastFrame()?.includes('写入完成') === true);
    expect(lastFrame()).toMatch(/思考了 \d+ 秒/);
    expect(lastFrame()).toContain('写入完成');
  });

  it('selects reject by default for execute approvals', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const llmClient = new WriteToolCallingLlmClient();
    const traceStore = new ObservableTraceStore(new InMemoryTraceStore());
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'fs.write',
      description: '执行外部命令',
      risk: 'execute',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({ content: 'executed' })
    });
    const runtime = new AgentRuntime({ traceStore, llmClient, toolGateway });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('执行命令');
    await waitUntil(() => lastFrame()?.includes('允许执行命令？') === true);

    expect(lastFrame()).toMatch(/[▸▹] 拒绝/);
  });

  it('renders live tool call lines while tools run', async () => {
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
    // 单行摘要（▪ Read …），不是多行 tool 卡片
    expect(lastFrame()).toMatch(/[▪▸▾].*Read/);

    await done;
    await waitUntil(() => lastFrame()?.includes('读完了') === true);
    expect(lastFrame()).toContain('Read');
    expect(lastFrame()).toContain('README.md');
    expect(lastFrame()).toContain('读完了');
  });

  it('aggregates multiple Read calls into Read N files and expands with ctrl+e', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    let toggleToolGroup: (() => void) | undefined;
    const llmClient = new MultiReadToolCallingLlmClient();
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
      <App
        runtime={runtime}
        onReady={(api) => {
          submit = api.submit;
          toggleToolGroup = api.toggleToolGroup;
        }}
      />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('读几个文件');
    await waitUntil(() => lastFrame()?.includes('Read 3 files') === true);
    expect(lastFrame()).toContain('Read 3 files');
    expect(lastFrame()).not.toContain('a.ts');
    expect(lastFrame()).toContain('ctrl+e');

    toggleToolGroup?.();
    await waitUntil(() => lastFrame()?.includes('a.ts') === true);
    expect(lastFrame()).toContain('b.ts');
    expect(lastFrame()).toContain('c.ts');
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
      await waitUntil(() => lastFrame()?.includes('允许修改工作区？') === true);

      expect(lastFrame()).toContain('fs.write');
      expect(lastFrame()).toContain('允许一次');
      expect(lastFrame()).toContain('拒绝');
      // 工具为单行摘要，审批面板仍用圆角框
      expect(lastFrame()).not.toContain('/approve');

      const approval = chooseToolApproval?.(true);
      await waitUntil(
        () => lastFrame()?.includes('运行已允许的工具') === true
      );
      expect(lastFrame()).toContain('已允许一次 fs.write');

      llmClient.releaseFollowup();
      await approval;
      await waitUntil(() => lastFrame()?.includes('写入完成') === true);

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
    // 权限只在 Composer 页脚；顶栏改为 Todo 进度。
    expect(lastFrame()).toContain('权限：默认');
    expect(lastFrame()).toContain('Todo · —');

    await submit?.('/perm classifier');
    await waitUntil(() => lastFrame()?.includes('权限：智能判断') === true);
    expect(runtime.getPermissionMode()).toBe('classifier');
    expect(lastFrame()).toContain('权限：智能判断');

    await submit?.('/perm auto');
    await waitUntil(() => lastFrame()?.includes('权限：自动允许') === true);
    expect(runtime.getPermissionMode()).toBe('auto');
    expect(lastFrame()).toContain('权限：自动允许');
  });

  it('shows session todos in the header and expands the full list on toggle', async () => {
    const { TodoStore } = await import('@kross/core');
    const todoStore = new TodoStore();
    let api: AppTestApi | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      todoStore,
      llmClient: new FakeLlmClient('ok')
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(next) => (api = next)} />
    );

    await waitUntil(() => api !== undefined);
    expect(lastFrame()).toContain('Todo · —');

    todoStore.write({
      todos: [
        { id: '1', content: '展示顶栏 Todo', status: 'completed' },
        { id: '2', content: '继续实现列表', status: 'in_progress' },
        { id: '3', content: '待办三项', status: 'pending' }
      ]
    });

    await waitUntil(() => lastFrame()?.includes('Todo 1/3 ▸') === true);
    // Collapsed: only progress chip, not the full list body.
    expect(lastFrame()).not.toContain('继续实现列表');

    api?.toggleTodoExpand();
    await waitUntil(() => lastFrame()?.includes('Todo 1/3 ▾') === true);
    expect(lastFrame()).toContain('✓ 展示顶栏 Todo');
    expect(lastFrame()).toContain('◻ 继续实现列表');
    expect(lastFrame()).toContain('☐ 待办三项');

    api?.toggleTodoExpand();
    await waitUntil(() => lastFrame()?.includes('Todo 1/3 ▸') === true);
    expect(lastFrame()).not.toContain('待办三项');
  });

  it('shows slash command suggestions while typing a prefix', async () => {
    let setInput: ((value: string) => void) | undefined;
    const { lastFrame } = render(
      <App onReady={(api) => (setInput = api.setInput)} />
    );

    await waitUntil(() => setInput !== undefined);
    setInput?.('/');
    await waitUntil(() => lastFrame()?.includes('查看全部命令') === true);
    expect(lastFrame()).toContain('命令');
    expect(lastFrame()).toContain('/help');
    expect(lastFrame()).toMatch(/还有 \d+ 项，继续输入筛选/);

    setInput?.('/mo');
    await waitUntil(() => lastFrame()?.includes('切换 Agent 模式') === true);
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

class FakeLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  model = 'fake-model';
  thinkingEffort: import('@kross/core').ThinkingEffort = 'medium';
  lastUsage: LlmResponse['usage'];

  constructor(private readonly text: string) {}

  setModel(model: string): void {
    this.model = model.trim();
  }

  setThinkingEffort(effort: import('@kross/core').ThinkingEffort): void {
    this.thinkingEffort = effort;
  }

  clearLastUsage(): void {
    this.lastUsage = undefined;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response: LlmResponse = {
      provider: this.provider,
      model: request.model ?? this.model,
      text: this.text,
      raw: {},
      usage: { inputTokens: 37, outputTokens: 5, totalTokens: 42 }
    };
    this.lastUsage = response.usage;
    return response;
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'text-delta', text: this.text };
    const usage = { inputTokens: 37, outputTokens: 5, totalTokens: 42 };
    this.lastUsage = usage;
    yield { type: 'done', usage };
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
  private readonly pending: Array<{
    settled: boolean;
    resolve: (value: string) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  resolveNext(text: string): void {
    let entry = this.pending.shift();
    while (entry?.settled) {
      entry = this.pending.shift();
    }
    if (entry) {
      entry.settled = true;
      entry.resolve(text);
    }
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    const text = await new Promise<string>((resolve, reject) => {
      const entry = { settled: false, resolve, reject };
      this.pending.push(entry);
      request.signal?.addEventListener(
        'abort',
        () => {
          if (!entry.settled) {
            entry.settled = true;
            reject(request.signal?.reason);
          }
        },
        { once: true }
      );
    });
    yield { type: 'text-delta', text };
    yield { type: 'done' };
  }
}

class MultiReadToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  private phase: 'tool' | 'final' = 'tool';

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    if (this.phase === 'tool') {
      this.phase = 'final';
      for (const [id, path] of [
        ['r1', 'a.ts'],
        ['r2', 'b.ts'],
        ['r3', 'c.ts']
      ] as const) {
        yield {
          type: 'tool-call',
          call: { id, name: 'Read', input: { path } }
        };
      }
      yield { type: 'done' };
      return;
    }
    yield { type: 'text-delta', text: '都读完了' };
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
