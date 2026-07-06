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
