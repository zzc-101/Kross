import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  chunkTextForStream,
  isCasualChatInput,
  parsePlanIntentKind
} from './agentRuntime';
import { InMemoryContextManager, type SessionContext } from '../context/sessionContext';
import type { LlmMessage } from '../llm/types';
import type { TraceEvent } from '../domain';
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk
} from '../llm/types';
import { ToolGateway } from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';
import { WorkspaceRoots } from '../workspace/workspaceRoots';
import { z } from 'zod';
import { initI18n, setLocale } from '../i18n';
import {
  streamFromComplete,
  getStoredConversation,
  InMemoryTraceStore,
  FakeLlmClient,
  FailingLlmClient,
  StreamingLlmClient,
  ThinkingStreamingLlmClient,
  MultiTurnStreamingToolClient,
  ToolCallingLlmClient,
  BuiltinWriteToolCallingLlmClient,
  MultiStepToolCallingLlmClient,
  LoopingToolCallingLlmClient,
  ReadThenWriteToolCallingLlmClient,
  ParallelToolCallingLlmClient,
  StreamingToolCallingLlmClient,
  LoopingStreamingToolClient,
  WriteToolCallingLlmClient,
  DoubleWriteApprovalLlmClient,
  AbortableStreamingLlmClient,
  SingleToolStreamingLlmClient,
  waitForAbort
} from './agentRuntime.testSupport';

describe('AgentRuntime lifecycle and context', () => {
  it('rebuilds the system prompt from the current locale for each run', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new FakeLlmClient('done');
    const runtime = new AgentRuntime({ traceStore, llmClient });

    try {
      initI18n('zh');
      await runtime.run({ input: 'first', requestedMode: 'auto' });
      const firstSystem = llmClient.requests[0]?.messages.find(
        (message) => message.role === 'system'
      );
      expect(firstSystem?.content).toContain('你是 Kross');
      expect(firstSystem?.content).toContain('Auto 模式：');

      setLocale('en');
      await runtime.run({ input: 'second', requestedMode: 'auto' });
      const secondSystem = llmClient.requests[1]?.messages.find(
        (message) => message.role === 'system'
      );
      expect(secondSystem?.content).toContain('You are Kross');
      expect(secondSystem?.content).toContain('Auto mode:');
      expect(secondSystem?.content).toContain('Session mode: auto');
    } finally {
      initI18n('zh');
    }
  });

  it('runs a normal task and records trace events', async () => {
      const traceStore = new InMemoryTraceStore();
      const runtime = new AgentRuntime({ traceStore });

      const result = await runtime.run({
        input: '帮我给当前模块补一个单元测试',
        requestedMode: 'auto'
      });

      expect(result.mode).toBe('auto');
      expect(result.status).toBe('failed');
      expect(result.summary).toContain('未配置模型');
      expect(traceStore.events.map((event) => event.type)).toEqual([
        'run.started',
        'run.phase.changed',
        'planner.started',
        'mode.detected',
        'run.phase.changed',
        'run.completed'
      ]);
      expect(
        traceStore.events
          .filter((event) => event.type === 'run.phase.changed')
          .map((event) => event.payload.phase)
      ).toEqual(['inspect', 'complete']);
    });

  it('reports planner LLM failures instead of saying the model is unconfigured', async () => {
      const traceStore = new InMemoryTraceStore();
      const runtime = new AgentRuntime({
        traceStore,
        llmClient: new FailingLlmClient('anthropic request failed with status 404')
      });

      const result = await runtime.run({
        input: '你好',
        requestedMode: 'auto'
      });

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('模型请求失败');
      expect(result.summary).toContain('anthropic request failed with status 404');
      expect(result.summary).not.toContain('未配置模型');
      expect(result.report.evidence).toContain(
        'LLM 请求失败: anthropic request failed with status 404'
      );
      expect(traceStore.events.map((event) => event.type)).toContain(
        'llm.planner.failed'
      );
    });

  it('treats aborting an LLM stream as cancelled and does not persist partial text', async () => {
      const traceStore = new InMemoryTraceStore();
      const sessionContext = new InMemoryContextManager();
      const llmClient = new AbortableStreamingLlmClient();
      const runtime = new AgentRuntime({ traceStore, sessionContext, llmClient });
      const controller = new AbortController();

      const running = runtime.run({
        input: '分析这个仓库',
        requestedMode: 'auto',
        signal: controller.signal
      });
      await llmClient.started;
      controller.abort(new Error('用户按下 Esc'));
      const result = await running;

      expect(result).toMatchObject({
        status: 'cancelled',
        cancellationReason: 'user-interrupt',
        summary: '已中断当前任务'
      });
      expect(sessionContext.getThread().getOpenTurnId()).toBeUndefined();
      expect(
        sessionContext
          .getThread()
          .buildMessages()
          .some(
            (message) =>
              message.role === 'assistant' && message.content.includes('半截回复')
          )
      ).toBe(false);
      expect(traceStore.events.map((event) => event.type)).toContain(
        'run.interrupted'
      );
      expect(traceStore.events.map((event) => event.type)).not.toContain(
        'llm.planner.failed'
      );
      expect(
        traceStore.events.filter((event) => event.type === 'run.completed')
      ).toHaveLength(1);
    });

  it('cancels a running tool and removes its unmatched call from Thread', async () => {
      const traceStore = new InMemoryTraceStore();
      const sessionContext = new InMemoryContextManager();
      const llmClient = new SingleToolStreamingLlmClient();
      const controller = new AbortController();
      let markToolStarted: (() => void) | undefined;
      const toolStarted = new Promise<void>((resolve) => {
        markToolStarted = resolve;
      });
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'long.read',
        description: '长时间读取',
        risk: 'read',
        inputSchema: z.object({}),
        execute: async ({ signal }) => {
          markToolStarted?.();
          return new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(signal.reason),
              { once: true }
            );
          });
        }
      });
      const runtime = new AgentRuntime({
        traceStore,
        sessionContext,
        llmClient,
        toolGateway
      });

      const running = runtime.run({
        input: '读取慢资源',
        requestedMode: 'auto',
        signal: controller.signal
      });
      await toolStarted;
      controller.abort(new Error('用户按下 Esc'));
      const result = await running;

      expect(result.status).toBe('cancelled');
      expect(traceStore.events.map((event) => event.type)).toContain(
        'tool_call.cancelled'
      );
      expect(traceStore.events.map((event) => event.type)).not.toContain(
        'tool_call.failed'
      );
      const assistant = sessionContext
        .getThread()
        .buildMessages()
        .find((message) => message.role === 'assistant');
      expect(assistant?.role).toBe('assistant');
      if (assistant?.role === 'assistant') {
        expect(assistant.toolCalls).toBeUndefined();
      }
    });

  it('conductor plans worker tasks and waits for approval', async () => {
      const traceStore = new InMemoryTraceStore();
      const runtime = new AgentRuntime({
        traceStore,
        workspaceRoot: '/tmp/primary-ws'
      });

      const result = await runtime.run({
        input: '用指挥家拆任务交给 worker',
        requestedMode: 'conductor',
        approvals: { plan: false }
      });

      expect(result.mode).toBe('conductor');
      expect(result.status).toBe('cancelled');
      expect(result.cancellationReason).toBe('approval-gate');
      expect(result.summary).toContain('指挥家计划');
      expect(runtime.getPendingConductorPlan()?.plan.tasks.length).toBeGreaterThan(
        0
      );
    });

  it('streams conductor progress and chunked plan without polluting summary', async () => {
      const runtime = new AgentRuntime({
        traceStore: new InMemoryTraceStore(),
        workspaceRoot: '/tmp/primary-ws'
      });

      const deltas: string[] = [];
      let resultSummary = '';
      for await (const event of runtime.runStreaming({
        input: '用指挥家拆任务交给 worker',
        requestedMode: 'conductor',
        approvals: { plan: false }
      })) {
        if (event.type === 'text-delta') {
          deltas.push(event.text);
        } else if (event.type === 'result') {
          resultSummary = event.result.summary;
        }
      }

      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas[0]).toContain('正在拆分任务');
      expect(deltas.join('')).toContain('指挥家计划');
      expect(resultSummary).toContain('指挥家计划');
      expect(resultSummary).not.toContain('正在拆分任务');
    });

  it('executes worker subagents then senior review after conductor approval', async () => {
      const traceStore = new InMemoryTraceStore();
      const workers: string[] = [];
      const reviewers: string[] = [];
      const validators: string[] = [];
      const runtime = new AgentRuntime({
        traceStore,
        llmClient: new FakeLlmClient('not-json'),
        workspaceRoot: '/tmp/ws',
        runSubagent: async (request) => {
          if (request.role === 'validator') {
            validators.push(request.title ?? 'validator');
            expect(request.mode).toBe('explore');
            expect(request.systemPrompt).toContain('validation worker');
            expect(request.verificationChangedFiles?.length).toBeGreaterThan(0);
            return {
              subRunId: `validation-${validators.length}`,
              mode: 'explore' as const,
              modeForcedToExplore: false,
              result: {
                status: 'completed' as const,
                summary: 'independent checks passed',
                changedFiles: [],
                diffSummary: [],
                commandsRun: ['npm test'],
                toolsUsed: ['Read', 'Verify'],
                verification: {
                  status: 'passed' as const,
                  commands: ['npm test'],
                  evidence: ['npm test: passed (exit=0)']
                },
                evidence: ['validation complete'],
                risks: [],
                needsReview: []
              }
            };
          }
          if (request.role === 'reviewer') {
            reviewers.push(request.title ?? 'reviewer');
            expect(request.preferWorkerModel).toBe(false);
            expect(request.mode).toBe('explore');
            expect(request.systemPrompt).toContain('高级模型');
            expect(request.prompt).toContain('最终工作树和 diff');
            return {
              subRunId: `review-${reviewers.length}`,
              mode: 'explore' as const,
              modeForcedToExplore: false,
              result: {
                status: 'completed' as const,
                summary: '真实 diff 已检查，存在验证缺口但不阻塞\nVERDICT: PASS',
                changedFiles: [],
                diffSummary: [],
                commandsRun: [],
                toolsUsed: [
                  'GitStatus',
                  'GitDiff',
                  'GitDiff:unstaged',
                  'GitDiff:staged',
                  'Read'
                ],
                verification: {
                  status: 'not-needed' as const,
                  commands: [],
                  evidence: []
                },
                evidence: ['GitStatus and GitDiff inspected'],
                risks: [],
                needsReview: []
              }
            };
          }
          workers.push(request.title ?? 'task');
          expect(request.preferWorkerModel).toBe(true);
          return {
            subRunId: `sub-${workers.length}`,
            mode: 'general' as const,
            modeForcedToExplore: false,
            result: {
              status: 'completed' as const,
              summary: `done ${request.title}`,
              changedFiles: [`${request.title}.ts`],
              diffSummary: [],
              commandsRun: [],
              toolsUsed: ['Read', 'Write'],
              verification: {
                status: 'not-run',
                commands: [],
                evidence: [],
                reason: 'mock worker did not run checks'
              },
              evidence: [],
              risks: [],
              needsReview: []
            }
          };
        }
      });

      await runtime.run({
        input: '指挥家：实现登录修复',
        requestedMode: 'conductor',
        approvals: { plan: false }
      });

      const result = await runtime.run({
        input: '指挥家：实现登录修复',
        requestedMode: 'conductor',
        approvals: { plan: true }
      });

      expect(result.status).toBe('completed');
      expect(workers.length).toBeGreaterThan(0);
      expect(validators).toHaveLength(1);
      expect(reviewers).toHaveLength(1);
      expect(result.summary).toContain('指挥家执行完成');
      expect(result.summary).toContain('真实 diff 已检查');
      expect(result.report.verification.status).toBe('passed');
      expect(traceStore.events.map((e) => e.type)).toContain(
        'conductor.execution.started'
      );
      expect(traceStore.events.map((e) => e.type)).toContain(
        'conductor.review.evidence'
      );
      expect(traceStore.events.map((e) => e.type)).toContain(
        'conductor.validation.evidence'
      );
      expect(traceStore.events.map((e) => e.type)).toContain(
        'conductor.review.completed'
      );
    });

  it('fails conductor acceptance when reviewer skips GitStatus or GitDiff', async () => {
      const traceStore = new InMemoryTraceStore();
      const runtime = new AgentRuntime({
        traceStore,
        llmClient: new FakeLlmClient('not-json'),
        workspaceRoot: '/tmp/ws',
        runSubagent: async (request) => ({
          subRunId:
            request.role === 'reviewer' ? 'review-without-tools' : 'worker-1',
          mode: request.mode === 'general' ? 'general' : 'explore',
          modeForcedToExplore: false,
          result: {
            status: 'completed',
            summary:
              request.role === 'reviewer'
                ? 'looks good without inspecting anything'
                : 'worker finished',
            changedFiles:
              request.role === 'reviewer' ? [] : ['src/worker.ts'],
            diffSummary: [],
            commandsRun: request.role === 'reviewer' ? [] : ['npm test'],
            toolsUsed: request.role === 'reviewer' ? [] : ['Write', 'Bash'],
            verification:
              request.role === 'reviewer'
                ? {
                    status: 'not-needed',
                    commands: [],
                    evidence: []
                  }
                : {
                    status: 'passed',
                    commands: ['npm test'],
                    evidence: ['npm test: exit=0']
                  },
            evidence: [],
            risks: [],
            needsReview: []
          }
        })
      });

      await runtime.run({
        input: '指挥家：实现并验收改动',
        requestedMode: 'conductor',
        approvals: { plan: false }
      });
      const result = await runtime.run({
        input: '指挥家：实现并验收改动',
        requestedMode: 'conductor',
        approvals: { plan: true }
      });

      expect(result.status).toBe('failed');
      expect(result.report.risks).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            '缺少工具证据：GitStatus, GitDiff(unstaged), GitDiff(staged)'
          )
        ])
      );
      expect(
        traceStore.events.find(
          (event) => event.type === 'conductor.review.completed'
        )?.payload
      ).toMatchObject({ reviewerIncomplete: true });
    });

  it('fails conductor acceptance when reviewer verdict is NEEDS_WORK', async () => {
      const traceStore = new InMemoryTraceStore();
      const runtime = new AgentRuntime({
        traceStore,
        llmClient: new FakeLlmClient('not-json'),
        workspaceRoot: '/tmp/ws',
        runSubagent: async (request) => ({
          subRunId:
            request.role === 'reviewer' ? 'review-needs-work' : 'worker-1',
          mode: request.mode === 'general' ? 'general' : 'explore',
          modeForcedToExplore: false,
          result: {
            status: 'completed',
            summary:
              request.role === 'reviewer'
                ? '发现会导致数据丢失的阻塞问题\nVERDICT: NEEDS_WORK'
                : 'worker finished',
            changedFiles:
              request.role === 'reviewer' ? [] : ['src/worker.ts'],
            diffSummary: [],
            commandsRun: request.role === 'reviewer' ? [] : ['npm test'],
            toolsUsed:
              request.role === 'reviewer'
                ? [
                    'GitStatus',
                    'GitDiff',
                    'GitDiff:unstaged',
                    'GitDiff:staged'
                  ]
                : ['Write', 'Bash'],
            verification:
              request.role === 'reviewer'
                ? {
                    status: 'not-needed',
                    commands: [],
                    evidence: []
                  }
                : {
                    status: 'passed',
                    commands: ['npm test'],
                    evidence: ['npm test: exit=0']
                  },
            evidence: [],
            risks: [],
            needsReview: []
          }
        })
      });

      await runtime.run({
        input: '指挥家：实现并验收改动',
        requestedMode: 'conductor',
        approvals: { plan: false }
      });
      const result = await runtime.run({
        input: '指挥家：实现并验收改动',
        requestedMode: 'conductor',
        approvals: { plan: true }
      });

      expect(result.status).toBe('failed');
      expect(result.report.risks).toContain(
        'primary: reviewer verdict=NEEDS_WORK'
      );
      expect(
        traceStore.events.find(
          (event) => event.type === 'conductor.review.completed'
        )?.payload
      ).toMatchObject({
        reviewerIncomplete: false,
        reviewerRejected: true
      });
    });

  it('returns a resumable cancellation when an approved conductor plan is missing a workspace root', async () => {
      const traceStore = new InMemoryTraceStore();
      const workspaceRoot = '/tmp/primary-ws';
      const runtime = new AgentRuntime({
        traceStore,
        workspaceRoot,
        workspaceRoots: new WorkspaceRoots(workspaceRoot)
      });
      runtime.restoreWorkState({
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

      const result = await runtime.run({
        input: '修改 API',
        requestedMode: 'conductor',
        approvals: { plan: true }
      });

      expect(result).toMatchObject({
        status: 'cancelled',
        cancellationReason: 'missing-workspace-root'
      });
      expect(result.summary).toContain('不存在的 workspace root');
      expect(runtime.getPendingModeExecution()).toBeDefined();
      expect(traceStore.events.map((event) => event.type)).toContain(
        'run.completed'
      );
    });

  it('uses an injected LLM client for planner assistance', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new FakeLlmClient();
      const runtime = new AgentRuntime({ traceStore, llmClient });

      const result = await runtime.run({
        input: '帮我设计一下登录测试',
        requestedMode: 'auto'
      });

      expect(llmClient.requests[0]?.messages[0]?.role).toBe('system');
      expect(llmClient.requests[0]?.messages[1]?.content).toContain(
        '帮我设计一下登录测试'
      );
      expect(result.report.evidence).toEqual([]);
      expect(traceStore.events.map((event) => event.type)).toContain(
        'llm.planner.completed'
      );
      const usage = runtime.getContextUsage({ requestedMode: 'auto' });
      expect(usage).toMatchObject({
        usedTokens: expect.any(Number),
        maxTokens: 480_000,
        lastUsageTokens: 10,
        label: expect.stringMatching(/\/480K$/)
      });
      expect(usage.usedTokens).toBeGreaterThan(0);
      expect(usage.ratio).toBeGreaterThan(0);
    });

  it('clears lastUsage when restoring a conversation', async () => {
      const llmClient = new FakeLlmClient('ok');
      const runtime = new AgentRuntime({
        traceStore: new InMemoryTraceStore(),
        llmClient
      });

      await runtime.run({
        input: '先产生 usage',
        requestedMode: 'auto'
      });
      expect(runtime.getContextUsage({ requestedMode: 'auto' }).usedTokens).toBeGreaterThan(
        0
      );

      runtime.restoreConversation([
        { role: 'user', content: '旧会话用户' },
        { role: 'assistant', content: '旧会话助手' }
      ]);

      expect(llmClient.lastUsage).toBeUndefined();
      const usage = runtime.getContextUsage({ requestedMode: 'auto' });
      expect(usage).toMatchObject({
        usedTokens: expect.any(Number),
        maxTokens: 480_000,
        lastUsageTokens: undefined,
        label: expect.stringMatching(/\/480K$/)
      });
      expect(usage.usedTokens).toBeGreaterThan(0);
      const context = runtime.inspectContext({ requestedMode: 'auto' });
      expect(context.messages.map((message) => message.content).join('\n')).toContain(
        '旧会话用户'
      );
    });

  it('uses LLM text as the normal chat response', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new FakeLlmClient('你好，我在。');
      const runtime = new AgentRuntime({ traceStore, llmClient });

      const result = await runtime.run({
        input: 'nihao',
        requestedMode: 'auto'
      });

      expect(result.status).toBe('completed');
      expect(result.summary).toBe('你好，我在。');
    });

  it('streams normal chat deltas before returning the final result', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new StreamingLlmClient(['你', '好']);
      const runtime = new AgentRuntime({ traceStore, llmClient });
      const events = [];

      for await (const event of runtime.runStreaming({
        input: 'nihao',
        requestedMode: 'auto'
      })) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: 'turn-start', iteration: 1 },
        { type: 'text-delta', text: '你' },
        { type: 'text-delta', text: '好' },
        {
          type: 'result',
          result: expect.objectContaining({
            status: 'completed',
            summary: '你好'
          })
        }
      ]);
      expect(llmClient.completeCalls).toBe(0);
      expect(llmClient.streamRequests[0]?.messages[1]?.content).toContain('nihao');
      expect(traceStore.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(['context.built', 'llm.planner.completed', 'run.completed'])
      );
    });

  it('streams thinking separately from text and does not put thinking into summary', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new ThinkingStreamingLlmClient();
      const runtime = new AgentRuntime({ traceStore, llmClient });
      const events = [];

      for await (const event of runtime.runStreaming({
        input: 'nihao',
        requestedMode: 'auto'
      })) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: 'turn-start', iteration: 1 },
        { type: 'thinking-delta', text: '先推理' },
        { type: 'text-delta', text: '结论' },
        {
          type: 'result',
          result: expect.objectContaining({
            status: 'completed',
            summary: '结论'
          })
        }
      ]);
      expect(events.find((event) => event.type === 'result')).toMatchObject({
        result: { summary: '结论' }
      });
      expect(JSON.stringify(events)).not.toContain('先推理结论');
    });

  it('emits turn-start and tools-start across multi-step tool streaming loops', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new MultiTurnStreamingToolClient();
      const toolGateway = new ToolGateway({
        traceStore,
        approvalPolicy: () => ({ action: 'allow' })
      });
      toolGateway.register({
        name: 'Read',
        description: 'read',
        risk: 'read',
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ input }) => ({ content: `ok:${input.path}` })
      });
      const runtime = new AgentRuntime({ traceStore, llmClient, toolGateway });
      const events = [];

      for await (const event of runtime.runStreaming({
        input: '读文件',
        requestedMode: 'auto'
      })) {
        events.push(event);
      }

      expect(events.filter((event) => event.type === 'turn-start')).toEqual([
        { type: 'turn-start', iteration: 1 },
        { type: 'turn-start', iteration: 2 }
      ]);
      expect(events).toContainEqual({
        type: 'tools-start',
        iteration: 1,
        count: 1
      });
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'turn-start',
          'thinking-delta',
          'tools-start',
          'turn-start',
          'text-delta',
          'result'
        ])
      );
      expect(
        events.find((event) => event.type === 'result')
      ).toMatchObject({
        result: {
          status: 'completed',
          summary: '读完了'
        }
      });
      // thinking 不进入最终 summary
      expect(
        (events.find((event) => event.type === 'result') as { result: { summary: string } })
          .result.summary
      ).not.toContain('想先读');
    });

  it('persists conversation history through the context manager', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new FakeLlmClient('第一轮回复');
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager: new InMemoryContextManager()
      });

      await runtime.run({
        input: '第一轮',
        requestedMode: 'auto'
      });
      llmClient.text = '第二轮回复';
      await runtime.run({
        input: '第二轮',
        requestedMode: 'auto'
      });

      const secondRequest = llmClient.requests[1];
      expect(secondRequest?.messages).toEqual([
        expect.objectContaining({ role: 'system' }),
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: '第一轮回复' },
        { role: 'user', content: '第二轮' }
      ]);
    });

  it('includes registered tool metadata in planner context', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new FakeLlmClient('可以读取文件');
      const toolGateway = new ToolGateway();
      toolGateway.register({
        name: 'fs.read',
        description: '读取文件内容',
        risk: 'read',
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({ content: 'file content' })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager: new InMemoryContextManager(),
        toolGateway
      });

      await runtime.run({
        input: '查看 README',
        requestedMode: 'auto'
      });

      expect(llmClient.requests[0]?.messages[0]?.content).toContain('fs.read');
      expect(llmClient.requests[0]?.messages[0]?.content).toContain('读取文件内容');
    });

  it('only exposes mode-gated tools in normal planner context', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new FakeLlmClient('ok');
      const toolGateway = new ToolGateway();
      toolGateway.register({
        name: 'cross.repo.scan',
        description: '扫描多仓库影响面',
        risk: 'read',
        inputSchema: z.object({}),
        enabled: ({ mode }) => mode === 'conductor',
        execute: async () => ({ content: 'ok' })
      });
      toolGateway.register({
        name: 'fs.read',
        description: '读取文件',
        risk: 'read',
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({ content: 'ok' })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager: new InMemoryContextManager(),
        toolGateway,
        workspaceRoot: '/tmp/ws'
      });

      await runtime.run({
        input: '解释一下 README',
        requestedMode: 'auto'
      });

      // normal mode: conductor-only tools must not appear
      expect(llmClient.requests[0]?.messages[0]?.content).toContain('fs.read');
      expect(llmClient.requests[0]?.messages[0]?.content).not.toContain(
        'cross.repo.scan'
      );

      // multi-dir phrasing stays on auto agent loop (not conductor)
      const cross = await runtime.run({
        input: '给字段做前后端联动',
        requestedMode: 'auto'
      });
      expect(cross.mode).toBe('auto');
      expect(llmClient.requests.length).toBeGreaterThanOrEqual(1);
    });
});
