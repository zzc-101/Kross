import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { TraceEvent } from '../domain';
import type { TraceStore } from '../trace/traceStore';
import { ToolGateway, ToolPermissionError, ToolValidationError } from './toolGateway';

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
