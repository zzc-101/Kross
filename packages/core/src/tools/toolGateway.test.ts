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
      enabled: ({ mode }) => mode === 'cross-repo',
      execute: async () => ({ content: 'ok' })
    });

    expect(gateway.listTools({ mode: 'normal' })).toEqual([
      expect.objectContaining({
        name: 'fs.read',
        category: 'filesystem',
        parameters: expect.objectContaining({ type: 'object' })
      })
    ]);
    expect(gateway.listTools({ mode: 'normal' })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'shell.exec' })])
    );
    expect(gateway.listTools({ mode: 'cross-repo' })).toEqual(
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
      input: { a: 1, b: 2 }
    });

    expect(result).toMatchObject({
      status: 'completed',
      content: '3'
    });
    expect(traceStore.events.map((event) => event.type)).toEqual([
      'tool_call.started',
      'tool_call.completed'
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
    const gateway = new ToolGateway({ defaultTimeoutMs: 5 });

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
    const gateway = new ToolGateway({ traceStore });

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

    expect(result).toMatchObject({
      status: 'failed',
      content: 'Tool boom failed: exploded',
      summary: 'failed: exploded'
    });
    expect(traceStore.events.map((event) => event.type)).toEqual([
      'tool_call.started',
      'tool_call.failed'
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
}
