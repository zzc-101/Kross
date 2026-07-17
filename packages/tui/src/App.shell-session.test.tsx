import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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
  ToolGateway,
  WorkspaceRoots
} from '@kross/core';
import { z } from 'zod';
import {
  InMemoryTraceStore,
  FakeLlmClient,
  ThinkingLlmClient,
  ControlledStreamingLlmClient,
  DelayedLlmClient,
  MultiReadToolCallingLlmClient,
  ReadToolCallingLlmClient,
  MultiTurnThinkingToolClient,
  WriteToolCallingLlmClient,
  waitUntil,
  createTempHome
} from './App.testSupport';

describe('App shell and sessions', () => {
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

  it('lists session-scoped managed processes with /processes', async () => {
      const { ProcessManager } = await import('@kross/core');
      const workspace = createTempHome();
      const processManager = new ProcessManager(workspace, {
        createProcessId: () => 'process-ui-test'
      });
      const started = await processManager.start({
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000)')}`
      });
      const runtime = new AgentRuntime({
        traceStore: new InMemoryTraceStore(),
        processManager
      });
      let api: AppTestApi | undefined;
      const view = render(
        <App runtime={runtime} cwd={workspace} onReady={(next) => (api = next)} />
      );

      try {
        await waitUntil(() => api !== undefined);
        await api?.submit('/processes');
        await waitUntil(() => view.lastFrame()?.includes(started.processId) === true);
        expect(view.lastFrame()).toContain('running');
      } finally {
        view.unmount();
        await processManager.close();
        rmSync(workspace, { recursive: true, force: true });
      }
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
      const workspace = join(homedir(), 'MyProject', 'agent');
      const cwdLabel = `~${sep}MyProject${sep}agent`;
      const { lastFrame } = render(
        <App
          branch="main"
          cwd={workspace}
          onReady={(api) => (submit = api.submit)}
        />
      );

      await waitUntil(() => submit !== undefined);
      expect(lastFrame()).toContain('随时可以开始');
      expect(lastFrame()).toContain('main');
      expect(lastFrame()).toContain(cwdLabel);
      // 路径只出现在顶栏，欢迎卡片内不再重复
      expect(lastFrame()?.split(cwdLabel).length).toBe(2);

      await submit?.('hello task');
      await waitUntil(() => lastFrame()?.includes('hello task') === true);
      expect(lastFrame()).toContain('>');
      expect(lastFrame()).toContain('Todo · —');
      expect(lastFrame()).toContain('权限：默认');
      // 进入对话后仍显示 branch/cwd，而不是 projectName=local
      expect(lastFrame()).toContain('main');
      expect(lastFrame()).toContain(cwdLabel);
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

  it('restores durable todos, mode and approval gate, then persists rejection', async () => {
      const { TodoStore } = await import('@kross/core');
      const homeDir = createTempHome();
      const workspace = join(homeDir, 'workspace');
      mkdirSync(workspace);
      const sessionStore = new HybridSessionStore({
        krossHome: join(homeDir, '.kross'),
        createSessionId: () => 'session-work-state-test'
      });
      const session = sessionStore.createSession(workspace);
      sessionStore.syncMessages(session.id, [
        { id: 1, from: 'user', text: '> 继续持久化计划' },
        { id: 2, from: 'agent', text: '计划等待确认' }
      ]);
      sessionStore.upsertWorkState(session.id, {
        version: 1,
        todos: [{ id: 'p0', content: '恢复工作状态', status: 'in_progress' }],
        sessionMode: 'plan',
        pendingModeExecution: {
          kind: 'plan',
          goal: '继续持久化计划',
          mode: 'plan',
          planText: '1. 恢复\n2. 验证'
        }
      });
      const runtime = new AgentRuntime({
        traceStore: new InMemoryTraceStore(),
        todoStore: new TodoStore(),
        llmClient: new FakeLlmClient('不应自动执行')
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
          () =>
            view.lastFrame()?.includes('Todo 0/1') === true &&
            view.lastFrame()?.includes('等待确认') === true
        );
        expect(runtime.getSessionMode()).toBe('plan');
        // Permission is process-local and never comes from the stored work state.
        expect(runtime.getPermissionMode()).toBe('default');
        expect(runtime.getPendingModeExecution()?.goal).toBe('继续持久化计划');

        await api?.choosePlanApproval(false);
        api?.flushSession();
        expect(runtime.getPendingModeExecution()).toBeUndefined();
        expect(
          sessionStore.loadSession(workspace, session.id)?.workState
            ?.pendingModeExecution
        ).toBeUndefined();
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
});
