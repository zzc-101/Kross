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

describe('App commands and model settings', () => {
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

  it('does not route removed /model list through the settings panel', async () => {
      let submit: ((value: string) => Promise<void>) | undefined;
      const runtime = new AgentRuntime({
        traceStore: new InMemoryTraceStore(),
        llmClient: new FakeLlmClient('ok')
      });
      const { lastFrame } = render(
        <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
      );

      await waitUntil(() => submit !== undefined);
      await submit?.('/model list');
      await waitUntil(() => lastFrame()?.includes('子命令已移除') === true);
      expect(runtime.getModelLabel()).toBe('fake-model (medium)');
    });

  it('shows unsupported public models via /free without adding them to /model', async () => {
    let submit: ((value: string) => Promise<void>) | undefined;
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('ok')
    });
    const { lastFrame } = render(
      <App runtime={runtime} onReady={(api) => (submit = api.submit)} />
    );

    await waitUntil(() => submit !== undefined);
    await submit?.('/free');
    await waitUntil(() => lastFrame()?.includes('GPT-5.6 Public') === true);
    expect(lastFrame()).toContain('暂未支持的公益模型');
    expect(lastFrame()).toContain('gpt-5.6-luna');
    expect(lastFrame()).toContain('gpt-5.6-sol');
    expect(lastFrame()).toContain('gpt-5.6-terra');
    expect(lastFrame()).toContain('Codex CLI');
    expect(lastFrame()).toContain('API Key');
    expect(lastFrame()).toContain('sk-qSELE');
    expect(lastFrame()).toContain('仅作公益模型信息分享');
    expect(lastFrame()).toContain('感谢公益站维护者');

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
});
