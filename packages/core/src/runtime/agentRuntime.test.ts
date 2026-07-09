import { describe, expect, it } from 'vitest';

import { AgentRuntime } from './agentRuntime';
import { InMemoryContextManager } from '../context/contextManager';
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

describe('AgentRuntime', () => {
  it('runs a normal task and records trace events', async () => {
    const traceStore = new InMemoryTraceStore();
    const runtime = new AgentRuntime({ traceStore });

    const result = await runtime.run({
      input: '帮我给当前模块补一个单元测试',
      requestedMode: 'auto'
    });

    expect(result.mode).toBe('normal');
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('未配置模型');
    expect(traceStore.events.map((event) => event.type)).toEqual([
      'run.started',
      'planner.started',
      'mode.detected',
      'plan.created',
      'review.completed',
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

  it('emits an approval gate before cross-repo execution', async () => {
    const traceStore = new InMemoryTraceStore();
    const runtime = new AgentRuntime({ traceStore });

    const result = await runtime.run({
      input: '给巡检任务增加任务来源字段，前后端联动',
      requestedMode: 'auto',
      approvals: { plan: false }
    });

    expect(result.mode).toBe('cross-repo');
    expect(result.status).toBe('cancelled');
    expect(traceStore.events.map((event) => event.type)).toContain(
      'approval.required'
    );
  });

  it('creates a cross-repo impact map placeholder when approved', async () => {
    const traceStore = new InMemoryTraceStore();
    const runtime = new AgentRuntime({ traceStore });

    const result = await runtime.run({
      input: '给巡检任务增加任务来源字段，前后端联动',
      requestedMode: 'auto',
      approvals: { plan: true }
    });

    expect(result.mode).toBe('cross-repo');
    expect(result.report.evidence).toContain('已生成跨仓库影响面占位图');
    expect(traceStore.events.map((event) => event.type)).toContain(
      'impact_map.created'
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
    expect(result.report.evidence).toContain('planner LLM 已返回计划建议');
    expect(traceStore.events.map((event) => event.type)).toContain(
      'llm.planner.completed'
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
      requestedMode: 'normal'
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

  it('only exposes tools enabled for the detected mode', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new FakeLlmClient('ok');
    const toolGateway = new ToolGateway();
    toolGateway.register({
      name: 'cross.repo.scan',
      description: '扫描多仓库影响面',
      risk: 'read',
      inputSchema: z.object({}),
      enabled: ({ mode }) => mode === 'cross-repo',
      execute: async () => ({ content: 'ok' })
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      contextManager: new InMemoryContextManager(),
      toolGateway
    });

    await runtime.run({
      input: '解释一下 README',
      requestedMode: 'auto'
    });
    await runtime.run({
      input: '给字段做前后端联动',
      requestedMode: 'auto'
    });

    expect(llmClient.requests[0]?.messages[0]?.content).not.toContain(
      'cross.repo.scan'
    );
    expect(llmClient.requests[1]?.messages[0]?.content).toContain(
      'cross.repo.scan'
    );
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
    expect(snapshot.mode).toBe('normal');
    expect(snapshot.report.sections.history).toBeGreaterThan(0);
    expect(snapshot.report.sections.tools).toBeGreaterThan(0);
    expect(snapshot.report.contributors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'history', section: 'history' }),
        expect.objectContaining({ id: 'tool:fs.read', section: 'tools' })
      ])
    );
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
  readonly requests: LlmRequest[] = [];

  constructor(public text = '1. 探索测试入口\n2. 补充断言') {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return {
      provider: this.provider,
      model: 'fake-model',
      text: this.text,
      raw: { ok: true },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }
    };
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
  }
}

class FailingLlmClient implements LlmClient {
  readonly provider = 'anthropic' as const;

  constructor(private readonly message: string) {}

  async complete(): Promise<LlmResponse> {
    throw new Error(this.message);
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
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

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
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

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
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

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
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

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
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

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
  }
}
