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

describe('App tool and status UI', () => {
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
