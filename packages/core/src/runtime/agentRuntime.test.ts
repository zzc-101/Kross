import { describe, expect, it } from 'vitest';

import { AgentRuntime } from './agentRuntime';
import type { TraceEvent } from '../domain';
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk
} from '../llm/types';
import type { TraceStore } from '../trace/traceStore';

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

  constructor(private readonly text = '1. 探索测试入口\n2. 补充断言') {}

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
