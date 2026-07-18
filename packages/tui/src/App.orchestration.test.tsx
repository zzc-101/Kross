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

describe('App orchestration and interruption', () => {
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

  it('clears durable plan approval state when Esc cancels the pending plan', async () => {
      let api: AppTestApi | undefined;
      const runtime = new AgentRuntime({
        traceStore: new InMemoryTraceStore(),
        llmClient: new FakeLlmClient('1. 检查现状\n2. 完成修改')
      });
      const view = render(
        <App runtime={runtime} onReady={(next) => (api = next)} />
      );

      await waitUntil(() => api !== undefined);
      await api?.submit('/mode plan');
      await api?.submit('先生成计划，等待我确认');
      await waitUntil(
        () =>
          runtime.getPendingModeExecution() !== undefined &&
          view.lastFrame()?.includes('等待确认') === true
      );

      expect(api?.interruptCurrentRun()).toBe(true);
      await waitUntil(() => runtime.getPendingModeExecution() === undefined);

      expect(view.lastFrame()).toContain('已取消计划');
    });

  it('keeps a restored conductor plan approvable after adding a missing workspace root', async () => {
      const homeDir = createTempHome();
      const workspace = join(homeDir, 'workspace');
      const extraRoot = join(homeDir, 'api');
      mkdirSync(workspace);
      mkdirSync(extraRoot);
      const sessionStore = new HybridSessionStore({
        krossHome: join(homeDir, '.kross'),
        createSessionId: () => 'session-missing-root-test'
      });
      const session = sessionStore.createSession(workspace);
      sessionStore.syncMessages(session.id, [
        { id: 1, from: 'user', text: '> 修改 API' },
        { id: 2, from: 'agent', text: '指挥家计划等待确认' }
      ]);
      sessionStore.upsertWorkState(session.id, {
        version: 1,
        todos: [],
        sessionMode: 'conductor',
        pendingModeExecution: {
          kind: 'conductor',
          goal: '修改 API',
          mode: 'conductor',
          plan: {
            goal: '修改 API',
            tasks: [
              {
                id: 'api-task',
                title: '修改 API',
                prompt: '完成 API 修改',
                repoId: 'api'
              }
            ]
          }
        }
      });
      const roots = new WorkspaceRoots(workspace);
      const runtime = new AgentRuntime({
        traceStore: new InMemoryTraceStore(),
        llmClient: new FakeLlmClient('验收通过'),
        workspaceRoot: workspace,
        workspaceRoots: roots,
        runSubagent: async (request) => ({
          subRunId: `sub-${request.repoId ?? 'local'}`,
          mode: request.mode === 'general' ? 'general' : 'explore',
          modeForcedToExplore: false,
          result: {
            status: 'completed',
            summary: 'worker completed',
            changedFiles: [],
            diffSummary: [],
            commandsRun: [],
            toolsUsed: [],
            verification: {
              status: 'not-needed',
              commands: [],
              evidence: []
            },
            evidence: [],
            risks: [],
            needsReview: []
          }
        })
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
            runtime.getPendingModeExecution() !== undefined &&
            view.lastFrame()?.includes('等待确认') === true
        );

        await api?.choosePlanApproval(true);
        await waitUntil(
          () => view.lastFrame()?.includes('不存在的 workspace root') === true
        );
        expect(runtime.getPendingModeExecution()).toBeDefined();
        expect(view.lastFrame()).toContain('等待确认');

        await api?.submit(`/add-dir ${extraRoot}`);
        expect(roots.resolveById('api')).toBe(extraRoot);
        await waitUntil(
          () => view.lastFrame()?.includes('已加入工作区 id=api') === true
        );
        await api?.choosePlanApproval(true);
        await waitUntil(() => runtime.getPendingModeExecution() === undefined);

        expect(view.lastFrame()).toContain('worker completed');
        expect(view.lastFrame()).toContain('高级模型验收');
      } finally {
        view.unmount();
        sessionStore.close();
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
});
