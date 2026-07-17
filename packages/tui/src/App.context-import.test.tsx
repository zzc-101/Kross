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

describe('App context and configuration import', () => {
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
});
