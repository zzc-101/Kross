import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { TraceEvent } from '../domain';
import type { TraceStore } from '../trace/traceStore';
import {
  ToolGateway,
  ToolPermissionError,
  ToolTimeoutError,
  ToolValidationError
} from './toolGateway';

describe('ToolGateway', () => {
  it('registers tools and returns public metadata', () => {
    const gateway = new ToolGateway();

    gateway.register({
      name: 'fs.read',
      description: '读取文件',
      risk: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ input }) => ({ content: `read ${input.path}` })
    });

    expect(gateway.listTools()).toEqual([
      {
        name: 'fs.read',
        description: '读取文件',
        risk: 'read'
      }
    ]);
  });

  it('exposes input schema metadata and filters conditionally enabled tools', () => {
    const gateway = new ToolGateway();

    gateway.register({
      name: 'fs.read',
      description: '读取文件',
      risk: 'read',
      category: 'filesystem',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      },
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ input }) => ({ content: `read ${input.path}` })
    });
    gateway.register({
      name: 'shell.exec',
      description: '执行 shell 命令',
      risk: 'execute',
      inputSchema: z.object({ cmd: z.string() }),
      enabled: ({ mode }) => mode === 'conductor',
      execute: async () => ({ content: 'ok' })
    });

    expect(gateway.listTools({ mode: 'auto' })).toEqual([
      expect.objectContaining({
        name: 'fs.read',
        category: 'filesystem',
        parameters: expect.objectContaining({ type: 'object' })
      })
    ]);
    expect(gateway.listTools({ mode: 'auto' })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'shell.exec' })])
    );
    expect(gateway.listTools({ mode: 'conductor' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'shell.exec' })])
    );
  });

  it('validates input, executes tools, and records trace events', async () => {
    const traceStore = new InMemoryTraceStore();
    const gateway = new ToolGateway({ traceStore });

    gateway.register({
      name: 'math.add',
      description: '加法',
      risk: 'read',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ input }) => ({ content: String(input.a + input.b) })
    });

    const result = await gateway.call({
      runId: 'run-1',
      name: 'math.add',
      input: { a: 1, b: 2 },
      iteration: 4
    });

    expect(result).toMatchObject({
      status: 'completed',
      content: '3'
    });
    expect(traceStore.events.map((event) => event.type)).toEqual([
      'tool_call.started',
      'tool_call.completed'
    ]);
    expect(traceStore.events.map((event) => event.payload.iteration)).toEqual([
      4,
      4
    ]);
  });

  it('blocks write and execute tools until explicitly approved', async () => {
    const gateway = new ToolGateway();

    gateway.register({
      name: 'fs.write',
      description: '写文件',
      risk: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({ content: 'written' })
    });

    await expect(
      gateway.call({
        runId: 'run-1',
        name: 'fs.write',
        input: { path: 'a.txt', content: 'hello' }
      })
    ).rejects.toBeInstanceOf(ToolPermissionError);

    await expect(
      gateway.call({
        runId: 'run-1',
        name: 'fs.write',
        input: { path: 'a.txt', content: 'hello' },
        approved: true
      })
    ).resolves.toMatchObject({ status: 'completed', content: 'written' });
  });

  it('supports custom approval policies with deny reasons', async () => {
    const traceStore = new InMemoryTraceStore();
    const gateway = new ToolGateway({
      traceStore,
      approvalPolicy: ({ input }) =>
        typeof input === 'object' &&
        input !== null &&
        'path' in input &&
        String(input.path).includes('.env')
          ? { action: 'deny', reason: 'secret file is protected' }
          : { action: 'allow' }
    });

    gateway.register({
      name: 'fs.write',
      description: '写文件',
      risk: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({ content: 'written' })
    });

    await expect(
      gateway.call({
        runId: 'run-1',
        name: 'fs.write',
        input: { path: '.env', content: 'secret' }
      })
    ).rejects.toMatchObject({
      reason: 'secret file is protected'
    });
    await expect(
      gateway.call({
        runId: 'run-1',
        name: 'fs.write',
        input: { path: 'README.md', content: 'hello' }
      })
    ).resolves.toMatchObject({ status: 'completed' });
    expect(traceStore.events.map((event) => event.type)).toEqual([
      'tool_call.denied',
      'tool_call.started',
      'tool_call.completed'
    ]);
  });

  it('times out slow tools and records a structured failure', async () => {
    const gateway = new ToolGateway({
      defaultTimeoutMs: 5,
      sleep: async () => undefined
    });

    gateway.register({
      name: 'slow',
      description: '慢工具',
      risk: 'read',
      inputSchema: z.object({}),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { content: 'late' };
      }
    });

    await expect(
      gateway.call({
        runId: 'run-1',
        name: 'slow',
        input: {}
      })
    ).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it('can return tool failures as observations for the agent loop', async () => {
    const traceStore = new InMemoryTraceStore();
    const gateway = new ToolGateway({
      traceStore,
      sleep: async () => undefined
    });

    gateway.register({
      name: 'boom',
      description: '失败工具',
      risk: 'read',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('exploded');
      }
    });

    const result = await gateway.call({
      runId: 'run-1',
      name: 'boom',
      input: {},
      returnErrors: true
    });

    // 默认最多 2 次 attempt，耗尽后仍回填模型
    expect(result).toMatchObject({
      status: 'failed',
      content: expect.stringContaining('failed after 2 attempts'),
      summary: expect.stringContaining('failed after 2 attempts')
    });
    expect(result.data).toMatchObject({
      attempts: 2,
      maxAttempts: 2,
      retried: true
    });
    expect(traceStore.events.map((event) => event.type)).toEqual([
      'tool_call.started',
      'tool_call.retry',
      'tool_call.failed'
    ]);
  });

  it('retries timeout then succeeds without extra tool loop iteration', async () => {
    const traceStore = new InMemoryTraceStore();
    let calls = 0;
    const gateway = new ToolGateway({
      traceStore,
      defaultTimeoutMs: 20,
      sleep: async () => undefined
    });

    gateway.register({
      name: 'flaky',
      description: '先超时再成功',
      risk: 'read',
      inputSchema: z.object({}),
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return { content: 'ok' };
      }
    });

    const result = await gateway.call({
      runId: 'run-1',
      name: 'flaky',
      input: {}
    });

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      status: 'completed',
      content: 'ok',
      data: { attempts: 2, retried: true }
    });
    expect(traceStore.events.map((event) => event.type)).toEqual([
      'tool_call.started',
      'tool_call.retry',
      'tool_call.completed'
    ]);
  });

  it('does not retry validation or boundary-style deterministic errors', async () => {
    const traceStore = new InMemoryTraceStore();
    let calls = 0;
    const gateway = new ToolGateway({
      traceStore,
      sleep: async () => undefined
    });

    gateway.register({
      name: 'strict',
      description: '参数校验',
      risk: 'read',
      inputSchema: z.object({ n: z.number() }),
      execute: async () => {
        calls += 1;
        return { content: 'unreachable' };
      }
    });

    await expect(
      gateway.call({
        runId: 'run-1',
        name: 'strict',
        input: { n: 'x' },
        returnErrors: true
      })
    ).rejects.toBeInstanceOf(ToolValidationError);
    expect(calls).toBe(0);
    // 校验失败发生在 execute 前，无 started
    expect(traceStore.events).toEqual([]);

    // 非 retryable 业务错误：单次失败即返回
    let boomCalls = 0;
    gateway.register({
      name: 'enoent-like',
      description: '确定性 IO 错误',
      risk: 'read',
      inputSchema: z.object({}),
      execute: async () => {
        boomCalls += 1;
        const error = new Error('not found') as Error & { code: string };
        error.code = 'ENOENT';
        throw error;
      }
    });

    const failed = await gateway.call({
      runId: 'run-2',
      name: 'enoent-like',
      input: {},
      returnErrors: true
    });
    expect(boomCalls).toBe(1);
    expect(failed).toMatchObject({
      status: 'failed',
      data: { attempts: 1, retried: false }
    });
    expect(failed.content).toContain('Tool enoent-like failed: not found');
    expect(failed.content).toContain('Recovery:');
  });

  it('respects call-level retry: false', async () => {
    let calls = 0;
    const gateway = new ToolGateway({ sleep: async () => undefined });
    gateway.register({
      name: 'boom',
      description: '失败',
      risk: 'read',
      inputSchema: z.object({}),
      execute: async () => {
        calls += 1;
        throw new Error('once');
      }
    });

    const result = await gateway.call({
      runId: 'run-1',
      name: 'boom',
      input: {},
      returnErrors: true,
      retry: false
    });
    expect(calls).toBe(1);
    expect(result.summary).toBe('failed: once');
  });

  it('forwards an external abort signal and never retries cancelled tools', async () => {
    const traceStore = new InMemoryTraceStore();
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gateway = new ToolGateway({ traceStore });
    gateway.register({
      name: 'long-running',
      description: '长时间运行',
      risk: 'read',
      inputSchema: z.object({}),
      execute: async ({ signal }) => {
        markStarted?.();
        return new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true }
          );
        });
      }
    });

    const call = gateway.call({
      runId: 'run-cancel',
      name: 'long-running',
      input: {},
      signal: controller.signal,
      returnErrors: true
    });
    await started;
    controller.abort(new Error('stop now'));

    await expect(call).rejects.toThrow('stop now');
    expect(traceStore.events.map((event) => event.type)).toEqual([
      'tool_call.started',
      'tool_call.cancelled'
    ]);
  });

  it('stores result summaries separately from raw output', async () => {
    const traceStore = new InMemoryTraceStore();
    const gateway = new ToolGateway({ traceStore, maxSummaryChars: 12 });

    gateway.register({
      name: 'logs.tail',
      description: '读取日志',
      risk: 'read',
      inputSchema: z.object({}),
      execute: async () => ({
        content: 'line '.repeat(20),
        summary: '日志有 20 行'
      })
    });

    const result = await gateway.call({
      runId: 'run-1',
      name: 'logs.tail',
      input: {}
    });

    expect(result.content.length).toBeGreaterThan(result.summary.length);
    expect(result.summary).toBe('日志有 20 行');
    expect(traceStore.events.at(-1)?.payload).toMatchObject({
      summary: '日志有 20 行'
    });
  });

  it('throws a typed validation error for invalid tool input', async () => {
    const gateway = new ToolGateway();

    gateway.register({
      name: 'math.add',
      description: '加法',
      risk: 'read',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async () => ({ content: 'unreachable' })
    });

    await expect(
      gateway.call({
        runId: 'run-1',
        name: 'math.add',
        input: { a: '1', b: 2 }
      })
    ).rejects.toBeInstanceOf(ToolValidationError);
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
