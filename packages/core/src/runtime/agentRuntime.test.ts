import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  isCasualChatInput,
  parsePlanModeIntent
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
import { z } from 'zod';

/** Adapt complete()-style fakes for run() which now drains the streaming tool loop. */
async function* streamFromComplete(
  response: LlmResponse
): AsyncIterable<LlmStreamChunk> {
  if (response.thinking) {
    yield { type: 'thinking-delta', text: response.thinking };
  }
  if (response.text) {
    yield { type: 'text-delta', text: response.text };
  }
  for (const call of response.toolCalls ?? []) {
    yield { type: 'tool-call', call };
  }
  yield { type: 'done' };
}

function getStoredConversation(
  sessionContext: SessionContext
): LlmMessage[] {
  return sessionContext.getCommittedDialog();
}

describe('AgentRuntime', () => {
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
      'planner.started',
      'mode.detected',
      'run.completed'
    ]);
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

  it('executes worker subagents then senior review after conductor approval', async () => {
    const traceStore = new InMemoryTraceStore();
    const spawned: string[] = [];
    const runtime = new AgentRuntime({
      traceStore,
      workspaceRoot: '/tmp/ws',
      runSubagent: async (request) => {
        spawned.push(request.title ?? 'task');
        expect(request.preferWorkerModel).toBe(true);
        return {
          subRunId: `sub-${spawned.length}`,
          mode: 'general' as const,
          modeForcedToExplore: false,
          result: {
            status: 'completed' as const,
            summary: `done ${request.title}`,
            changedFiles: [`${request.title}.ts`],
            diffSummary: [],
            commandsRun: [],
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
    expect(spawned.length).toBeGreaterThan(0);
    expect(result.summary).toContain('指挥家执行完成');
    expect(traceStore.events.map((e) => e.type)).toContain(
      'conductor.execution.started'
    );
    expect(traceStore.events.map((e) => e.type)).toContain(
      'conductor.review.completed'
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

  it('executes model tool calls and asks the LLM for a final answer with tool output', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new ToolCallingLlmClient();
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'math.add',
      description: '加法',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' }
        },
        required: ['a', 'b']
      },
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ input }) => ({
        content: String(input.a + input.b),
        summary: `${input.a} + ${input.b} = ${input.a + input.b}`
      })
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      contextManager: new InMemoryContextManager(),
      toolGateway
    });

    const result = await runtime.run({
      input: '计算 1 + 2',
      requestedMode: 'auto'
    });

    expect(result.summary).toBe('结果是 3');
    expect(llmClient.requests[0]?.tools).toEqual([
      expect.objectContaining({
        name: 'math.add',
        parameters: expect.objectContaining({ type: 'object' })
      })
    ]);
    expect(llmClient.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'call-1',
          name: 'math.add',
          content: '3'
        })
      ])
    );
    expect(traceStore.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'llm.tool_calls.received',
        'tool_call.started',
        'tool_call.completed',
        'llm.tool_followup.completed'
      ])
    );
  });

  it('continues tool-call iterations until the model returns a final text answer', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new MultiStepToolCallingLlmClient();
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'math.add',
      description: '加法',
      risk: 'read',
      parameters: { type: 'object', properties: {} },
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ input }) => ({ content: String(input.a + input.b) })
    });
    toolGateway.register({
      name: 'math.double',
      description: '翻倍',
      risk: 'read',
      parameters: { type: 'object', properties: {} },
      inputSchema: z.object({ value: z.number() }),
      execute: async ({ input }) => ({ content: String(input.value * 2) })
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      contextManager: new InMemoryContextManager(),
      toolGateway
    });

    const result = await runtime.run({
      input: '先算 1+2 再翻倍',
      requestedMode: 'auto'
    });

    expect(result.summary).toBe('最终结果是 6');
    expect(llmClient.requests).toHaveLength(3);
    expect(llmClient.requests[2]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'call-2',
          name: 'math.double',
          content: '6'
        })
      ])
    );
  });

  it('soft-lands when non-streaming tool-call iterations exceed the limit', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new LoopingToolCallingLlmClient();
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'fs.read',
      description: '读文件',
      risk: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ content: 'file content' })
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      toolGateway,
      maxToolIterations: 1
    });

    const result = await runtime.run({
      input: '一直读',
      requestedMode: 'auto'
    });

    // 触顶不再 failed，而是软着陆为 completed 总结
    expect(result.status).toBe('completed');
    expect(result.summary).toMatch(/收尾|上限|停止/);
    expect(traceStore.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'llm.tool_loop.max_iterations',
        'llm.soft_land.completed'
      ])
    );
    expect(
      traceStore.events.some(
        (event) =>
          event.type === 'llm.tool_loop.max_iterations' &&
          event.payload.softLand === true
      )
    ).toBe(true);
  });

  it('pauses for approval on risky tool calls and resumes when approved', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new WriteToolCallingLlmClient();
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'fs.write',
      description: '写文件',
      risk: 'write',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      },
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ input }) => ({
        content: `wrote ${input.path}`,
        summary: `wrote ${input.path}`
      })
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      contextManager: new InMemoryContextManager(),
      toolGateway
    });

    const pending = await runtime.run({
      input: '写 README',
      requestedMode: 'auto'
    });

    expect(pending.status).toBe('approval-required');
    expect(pending.pendingApproval).toMatchObject({
      runId: pending.runId,
      toolCallId: 'write-1',
      toolName: 'fs.write',
      risk: 'write'
    });
    expect(llmClient.requests).toHaveLength(1);

    const resumed = await runtime.resolveToolApproval({
      runId: pending.runId,
      approved: true
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.summary).toBe('写入完成');
    expect(llmClient.requests).toHaveLength(2);
    expect(traceStore.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'tool_call.approval_required',
        'tool_call.started',
        'tool_call.completed',
        'llm.tool_followup.completed'
      ])
    );
  });

  it('resumes with a rejected observation when risky tool approval is denied', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new WriteToolCallingLlmClient('已取消写入');
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'fs.write',
      description: '写文件',
      risk: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({ content: 'should not run' })
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      contextManager: new InMemoryContextManager(),
      toolGateway
    });

    const pending = await runtime.run({
      input: '写 README',
      requestedMode: 'auto'
    });
    const resumed = await runtime.resolveToolApproval({
      runId: pending.runId,
      approved: false
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.summary).toBe('已取消写入');
    expect(llmClient.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'write-1',
          name: 'fs.write',
          content: expect.stringContaining('rejected by user')
        })
      ])
    );
    expect(traceStore.events.map((event) => event.type)).toContain(
      'tool_call.rejected'
    );
  });

  it('pauses for approval when a risky tool call appears in later iterations', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new ReadThenWriteToolCallingLlmClient();
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'fs.read',
      description: '读文件',
      risk: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ content: 'file content' })
    });
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
      contextManager: new InMemoryContextManager(),
      toolGateway
    });

    const pending = await runtime.run({
      input: '读取后改写 README',
      requestedMode: 'auto'
    });

    expect(pending.status).toBe('approval-required');
    expect(pending.pendingApproval?.toolCallId).toBe('write-1');
    expect(pending.summary).toContain('fs.write');

    const resumed = await runtime.resolveToolApproval({
      runId: pending.runId,
      approved: true
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.summary).toBe('改写完成');
  });

  it('resumes parallel tool calls with every tool result backfilled in order', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new ParallelToolCallingLlmClient();
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'fs.read',
      description: '读文件',
      risk: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ content: 'file content' })
    });
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
      contextManager: new InMemoryContextManager(),
      toolGateway
    });

    const pending = await runtime.run({
      input: '读并写 README',
      requestedMode: 'auto'
    });

    expect(pending.status).toBe('approval-required');
    expect(pending.pendingApproval?.toolCallId).toBe('write-1');

    const resumed = await runtime.resolveToolApproval({
      runId: pending.runId,
      approved: true
    });

    expect(resumed.status).toBe('completed');
    const followupMessages = llmClient.requests[1]?.messages ?? [];
    expect(followupMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          toolCalls: [
            expect.objectContaining({ id: 'read-1' }),
            expect.objectContaining({ id: 'write-1' })
          ]
        }),
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'read-1',
          content: 'file content'
        }),
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'write-1',
          content: 'wrote README.md'
        })
      ])
    );
    const toolCallIds = followupMessages.flatMap((message) =>
      message.role === 'tool' ? [message.toolCallId] : []
    );
    expect(toolCallIds).toEqual(['read-1', 'write-1']);
  });

  it('streams follow-up text after tool approval instead of dumping complete()', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new WriteToolCallingLlmClient('写入完成');
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

    const first = await runtime.run({
      input: '写 README',
      requestedMode: 'auto'
    });
    expect(first.status).toBe('approval-required');

    const events = [];
    for await (const event of runtime.resolveToolApprovalStreaming({
      runId: first.runId,
      approved: true
    })) {
      events.push(event);
    }

    const textDeltas = events
      .filter((event) => event.type === 'text-delta')
      .map((event) => (event.type === 'text-delta' ? event.text : ''));
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.join('')).toBe('写入完成');
    expect(events.at(-1)).toEqual({
      type: 'result',
      result: expect.objectContaining({
        status: 'completed',
        summary: '写入完成'
      })
    });
  });

  it('appends the original user input after tool approval instead of a pseudo message', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new WriteToolCallingLlmClient('写入完成');
    const contextManager = new InMemoryContextManager();
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
      contextManager,
      toolGateway
    });

    const pending = await runtime.run({
      input: '写 README',
      requestedMode: 'auto'
    });
    expect(pending.status).toBe('approval-required');
    expect(getStoredConversation(contextManager)).toHaveLength(0);

    const resumed = await runtime.resolveToolApproval({
      runId: pending.runId,
      approved: true
    });
    expect(resumed.status).toBe('completed');

    const history = getStoredConversation(contextManager);
    expect(history).toEqual([
      { role: 'user', content: '写 README' },
      { role: 'assistant', content: '写入完成' }
    ]);
    expect(
      history.some(
        (message) =>
          message.role === 'user' && message.content === '[tool approval]'
      )
    ).toBe(false);
  });

  it('carries the same original user input through chained tool approvals', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new DoubleWriteApprovalLlmClient();
    const contextManager = new InMemoryContextManager();
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
      contextManager,
      toolGateway
    });

    const firstPending = await runtime.run({
      input: '连续写两个文件',
      requestedMode: 'auto'
    });
    expect(firstPending.status).toBe('approval-required');

    const secondPending = await runtime.resolveToolApproval({
      runId: firstPending.runId,
      approved: true
    });
    expect(secondPending.status).toBe('approval-required');

    const completed = await runtime.resolveToolApproval({
      runId: secondPending.runId,
      approved: true
    });
    expect(completed.status).toBe('completed');

    const history = getStoredConversation(contextManager);
    expect(history).toEqual([
      { role: 'user', content: '连续写两个文件' },
      { role: 'assistant', content: '两次写入完成' }
    ]);
  });

  it('cancelPendingApprovals records cancelled runs and appends conversation', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new WriteToolCallingLlmClient();
    const contextManager = new InMemoryContextManager();
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'fs.write',
      description: '写文件',
      risk: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({ content: 'should not run' })
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      contextManager,
      toolGateway
    });

    const pending = await runtime.run({
      input: '写 README',
      requestedMode: 'auto'
    });
    expect(pending.status).toBe('approval-required');

    const cancelledRunIds = await runtime.cancelPendingApprovals('process exit');
    expect(cancelledRunIds).toEqual([pending.runId]);

    const completed = traceStore.events.find(
      (event) =>
        event.runId === pending.runId && event.type === 'run.completed'
    );
    expect(completed?.payload).toMatchObject({
      status: 'cancelled',
      reason: 'process exit'
    });
    expect(String(completed?.payload.summary)).toContain('process exit');

    expect(getStoredConversation(contextManager)).toEqual([
      { role: 'user', content: '写 README' },
      {
        role: 'assistant',
        content: expect.stringContaining('process exit')
      }
    ]);
  });

  it('streams text deltas across tool-call iterations', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new StreamingToolCallingLlmClient();
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'fs.read',
      description: '读文件',
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

    const events = [];
    for await (const event of runtime.runStreaming({
      input: '查看 README',
      requestedMode: 'auto'
    })) {
      events.push(event);
    }

    const textDeltas = events
      .filter((event) => event.type === 'text-delta')
      .map((event) => (event.type === 'text-delta' ? event.text : ''));
    // 多轮 text-delta 不再注入分隔符（UI 按 turn-start 分气泡）；summary 仍拼接历史
    expect(textDeltas).toEqual(['让我查一下', '文件内容已读取']);
    expect(events.filter((event) => event.type === 'turn-start')).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tools-start', count: 1 })
    );
    expect(events.at(-1)).toEqual({
      type: 'result',
      result: expect.objectContaining({
        status: 'completed',
        summary: '让我查一下\n\n文件内容已读取'
      })
    });
    expect(llmClient.streamRequests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'read-1',
          content: 'file content'
        })
      ])
    );
    expect(traceStore.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'llm.tool_calls.received',
        'tool_call.completed',
        'llm.tool_followup.completed'
      ])
    );
  });

  it('soft-lands when streaming tool-call iterations exceed the limit', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new LoopingStreamingToolClient();
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'fs.read',
      description: '读文件',
      risk: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ content: 'file content' })
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      toolGateway,
      maxToolIterations: 1
    });
    const events = [];

    for await (const event of runtime.runStreaming({
      input: '一直读',
      requestedMode: 'auto'
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: 'result',
      result: expect.objectContaining({
        status: 'completed',
        summary: expect.stringMatching(/收尾|上限|停止/)
      })
    });
    expect(traceStore.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'llm.tool_loop.max_iterations',
        'llm.soft_land.completed'
      ])
    );
  });

  it('records a context report before planner LLM calls', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new FakeLlmClient('ok');
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      contextManager: new InMemoryContextManager()
    });

    await runtime.run({
      input: 'hello',
      requestedMode: 'auto'
    });

    const contextEvent = traceStore.events.find(
      (event) => event.type === 'context.built'
    );
    expect(contextEvent?.payload).toMatchObject({
      includedSources: [],
      droppedSources: [],
      report: expect.objectContaining({
        totalChars: expect.any(Number),
        sections: expect.objectContaining({
          system: expect.any(Number),
          history: expect.any(Number)
        })
      })
    });
    expect(llmClient.requests[0]?.metadata).toMatchObject({
      contextReport: expect.objectContaining({
        totalChars: expect.any(Number)
      })
    });
  });

  it('inspects the current session context without calling the LLM', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new FakeLlmClient('第一轮回复');
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
      input: '第一轮',
      requestedMode: 'auto'
    });
    const beforeInspectCalls = llmClient.requests.length;

    const snapshot = runtime.inspectContext({
      requestedMode: 'auto',
      currentUserInput: ''
    });

    expect(llmClient.requests).toHaveLength(beforeInspectCalls);
    expect(snapshot.mode).toBe('auto');
    expect(snapshot.report.sections.history).toBeGreaterThan(0);
    expect(snapshot.report.sections.tools).toBeGreaterThan(0);
    expect(snapshot.report.contributors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'history', section: 'history' }),
        expect.objectContaining({ id: 'tool:fs.read', section: 'tools' })
      ])
    );
  });

  it('lists and inspects traces for /trace command', async () => {
    const traceStore = new InMemoryTraceStore();
    const runtime = new AgentRuntime({
      traceStore,
      llmClient: new FakeLlmClient('计划完成'),
      createRunId: () => 'run-trace-1'
    });

    await runtime.run({
      input: '修复登录 bug',
      requestedMode: 'auto'
    });

    const listed = await runtime.listTraces({ limit: 5 });
    expect(listed[0]).toMatchObject({
      runId: 'run-trace-1',
      status: 'completed',
      mode: 'auto',
      inputPreview: '修复登录 bug'
    });

    const detail = await runtime.inspectTrace('run-trace-1');
    expect(detail?.summaryPreview).toContain('计划完成');

    const listText = await runtime.formatTraceCommand();
    expect(listText).toContain('run-trace-1');
    expect(listText).toContain('修复登录 bug');

    const detailText = await runtime.formatTraceCommand('run-trace-1');
    expect(detailText).toContain('Trace: run-trace-1');
    expect(detailText).toContain('completed');

    const missing = await runtime.formatTraceCommand('run-missing');
    expect(missing).toContain('未找到 run');
  });

  it('fills report.changedFiles from Write/Edit tool calls and formats /diff', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new BuiltinWriteToolCallingLlmClient();
    const toolGateway = new ToolGateway({ traceStore });
    toolGateway.register({
      name: 'Write',
      description: 'write',
      risk: 'write',
      inputSchema: z.object({
        path: z.string(),
        content: z.string()
      }),
      execute: async () => ({ content: 'ok', summary: 'wrote 5 bytes' })
    });

    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      toolGateway,
      createRunId: () => 'run-diff-1',
      workspaceRoot: '/tmp/workspace',
      runGit: async (args) => {
        if (args[0] === 'status') {
          return { stdout: '?? src/demo.ts\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    });
    // Runtime 会覆盖 gateway 的 approvalPolicy；用 auto 放行 Write
    runtime.setPermissionMode('auto');

    const result = await runtime.run({
      input: '写个文件',
      requestedMode: 'auto'
    });

    expect(result.report.changedFiles).toEqual(['src/demo.ts']);

    const completed = (await traceStore.readRun('run-diff-1')).find(
      (event) => event.type === 'run.completed'
    );
    expect(completed?.payload).toMatchObject({
      report: { changedFiles: ['src/demo.ts'] }
    });

    const diffText = await runtime.formatDiffCommand();
    expect(diffText).toContain('run: run-diff-1');
    expect(diffText).toContain('src/demo.ts  [Write]');
    expect(diffText).toContain('?? src/demo.ts');

    const missing = await runtime.formatDiffCommand('run-missing');
    expect(missing).toContain('未找到 run');

    const unsafe = await runtime.formatDiffCommand('../escape');
    expect(unsafe).toContain('无效 runId');
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
  readonly requests: LlmRequest[] = [];
  readonly contextWindow = 512_000;
  lastUsage = undefined as LlmResponse['usage'];

  constructor(public text = '1. 探索测试入口\n2. 补充断言') {}

  clearLastUsage(): void {
    this.lastUsage = undefined;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const response: LlmResponse = {
      provider: this.provider,
      model: 'fake-model',
      text: this.text,
      raw: { ok: true },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }
    };
    this.lastUsage = response.usage;
    return response;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    const response: LlmResponse = {
      provider: this.provider,
      model: 'fake-model',
      text: this.text,
      raw: { ok: true },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }
    };
    this.lastUsage = response.usage;
    yield* streamFromComplete(response);
  }
}

class FailingLlmClient implements LlmClient {
  readonly provider = 'anthropic' as const;

  constructor(private readonly message: string) {}

  async complete(): Promise<LlmResponse> {
    throw new Error(this.message);
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    throw new Error(this.message);
  }
}

class StreamingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly streamRequests: LlmRequest[] = [];
  completeCalls = 0;

  constructor(private readonly chunks: string[]) {}

  async complete(): Promise<LlmResponse> {
    this.completeCalls += 1;
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.streamRequests.push(request);
    for (const text of this.chunks) {
      yield { type: 'text-delta', text };
    }
    yield { type: 'done' };
  }
}

class ThinkingStreamingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'thinking-delta', text: '先推理' };
    yield { type: 'text-delta', text: '结论' };
    yield { type: 'done' };
  }
}

class MultiTurnStreamingToolClient implements LlmClient {
  readonly provider = 'openai' as const;
  private phase: 'tool' | 'final' = 'tool';

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    if (this.phase === 'tool') {
      this.phase = 'final';
      yield { type: 'thinking-delta', text: '想先读' };
      yield {
        type: 'tool-call',
        call: { id: 'read-1', name: 'Read', input: { path: 'a.ts' } }
      };
      yield { type: 'done' };
      return;
    }

    yield { type: 'text-delta', text: '读完了' };
    yield { type: 'done' };
  }
}

class ToolCallingLlmClient implements LlmClient {
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
            id: 'call-1',
            name: 'math.add',
            input: { a: 1, b: 2 }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '结果是 3',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

class BuiltinWriteToolCallingLlmClient implements LlmClient {
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
            id: 'write-builtin-1',
            name: 'Write',
            input: { path: 'src/demo.ts', content: 'hello' }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '写完了',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

class MultiStepToolCallingLlmClient implements LlmClient {
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
        toolCalls: [{ id: 'call-1', name: 'math.add', input: { a: 1, b: 2 } }]
      };
    }
    if (this.requests.length === 2) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [{ id: 'call-2', name: 'math.double', input: { value: 3 } }]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '最终结果是 6',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

class LoopingToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    // 软着陆请求不带 tools
    if (!request.tools || request.tools.length === 0) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '收尾：工具轮次已满，已停止继续读文件',
        raw: {}
      };
    }
    return {
      provider: this.provider,
      model: 'fake-model',
      text: '',
      raw: {},
      toolCalls: [
        {
          id: `read-${this.requests.length}`,
          name: 'fs.read',
          input: { path: 'README.md' }
        }
      ]
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

class ReadThenWriteToolCallingLlmClient implements LlmClient {
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
        toolCalls: [{ id: 'read-1', name: 'fs.read', input: { path: 'README.md' } }]
      };
    }
    if (this.requests.length === 2) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [
          {
            id: 'write-1',
            name: 'fs.write',
            input: { path: 'README.md', content: 'new content' }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '改写完成',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

class ParallelToolCallingLlmClient implements LlmClient {
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
          { id: 'read-1', name: 'fs.read', input: { path: 'README.md' } },
          {
            id: 'write-1',
            name: 'fs.write',
            input: { path: 'README.md', content: 'new content' }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '读写完成',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

class StreamingToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly streamRequests: LlmRequest[] = [];

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.streamRequests.push(request);
    if (this.streamRequests.length === 1) {
      yield { type: 'text-delta', text: '让我查一下' };
      yield {
        type: 'tool-call',
        call: { id: 'read-1', name: 'fs.read', input: { path: 'README.md' } }
      };
      yield { type: 'done' };
      return;
    }

    yield { type: 'text-delta', text: '文件内容已读取' };
    yield { type: 'done' };
  }
}

class LoopingStreamingToolClient implements LlmClient {
  readonly provider = 'openai' as const;
  private count = 0;

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(request?: LlmRequest): AsyncIterable<LlmStreamChunk> {
    if (!request?.tools || request.tools.length === 0) {
      yield { type: 'text-delta', text: '收尾：工具轮次已满，已停止继续读文件' };
      yield { type: 'done' };
      return;
    }
    this.count += 1;
    yield {
      type: 'tool-call',
      call: {
        id: `read-${this.count}`,
        name: 'fs.read',
        input: { path: 'README.md' }
      }
    };
    yield { type: 'done' };
  }
}

class WriteToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  constructor(private readonly finalText = '写入完成') {}

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
      text: this.finalText,
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

class DoubleWriteApprovalLlmClient implements LlmClient {
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
            input: { path: 'a.txt', content: 'a' }
          }
        ]
      };
    }
    if (this.requests.length === 2) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [
          {
            id: 'write-2',
            name: 'fs.write',
            input: { path: 'b.txt', content: 'b' }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '两次写入完成',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

class AbortableStreamingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly started: Promise<void>;
  private markStarted: (() => void) | undefined;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield { type: 'text-delta', text: '半截回复' };
    this.markStarted?.();
    await waitForAbort(request.signal);
  }
}

class SingleToolStreamingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield {
      type: 'tool-call',
      call: { id: 'long-1', name: 'long.read', input: {} }
    };
    yield { type: 'done' };
  }
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) {
      reject(new Error('missing signal'));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true
    });
  });
}

describe('isCasualChatInput', () => {
  it('recognizes greetings and rejects real tasks', () => {
    expect(isCasualChatInput('你好')).toBe(true);
    expect(isCasualChatInput('hello!')).toBe(true);
    expect(isCasualChatInput('修复登录 bug')).toBe(false);
    expect(isCasualChatInput('先规划再实现认证')).toBe(false);
  });
});

describe('parsePlanModeIntent', () => {
  it('parses chat and plan JSON from the model', () => {
    expect(
      parsePlanModeIntent(
        '你好',
        '{"kind":"chat","reply":"你好呀","reason":"greeting"}'
      )
    ).toEqual({
      kind: 'chat',
      reply: '你好呀',
      reason: 'greeting'
    });
    expect(
      parsePlanModeIntent(
        '修登录',
        '```json\n{"kind":"plan","plan":"1. 读代码\\n2. 改","reason":"task"}\n```'
      )
    ).toMatchObject({ kind: 'plan', reason: 'task' });
  });
});
