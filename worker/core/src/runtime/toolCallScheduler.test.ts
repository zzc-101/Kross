import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk
} from '../llm/types';
import { ToolGateway } from '../tools/toolGateway';
import { AgentRuntime } from './agentRuntime';
import { InMemoryTraceStore } from './agentRuntime.testSupport';
import { executeScheduledToolCalls } from './toolLoopShared';

describe('tool call scheduler', () => {
  it('uses the same controlled read concurrency in the main agent loop', async () => {
    const traceStore = new InMemoryTraceStore();
    const gateway = new ToolGateway({ traceStore });
    let active = 0;
    let maxActive = 0;
    gateway.register({
      name: 'Read',
      description: 'read',
      risk: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ input }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { content: input.path };
      }
    });
    const runtime = new AgentRuntime({
      traceStore,
      toolGateway: gateway,
      llmClient: new ReadBatchClient()
    });

    const result = await runtime.run({
      input: 'read both files',
      requestedMode: 'auto'
    });
    expect(result.status).toBe('completed');
    expect(maxActive).toBe(2);
  });

  it('runs independent reads concurrently, preserves result order and fences writes', async () => {
    const events: string[] = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    let releaseReads!: () => void;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const gateway = new ToolGateway({
      approvalPolicy: () => ({ action: 'allow' })
    });
    gateway.register({
      name: 'Read',
      description: 'read',
      risk: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ input }) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        events.push(`start:${input.path}`);
        if (activeReads === 2) releaseReads();
        await readsReleased;
        activeReads -= 1;
        events.push(`end:${input.path}`);
        return { content: input.path };
      }
    });
    gateway.register({
      name: 'Write',
      description: 'write',
      risk: 'write',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ input }) => {
        events.push(`write:${input.path}`);
        return { content: `wrote:${input.path}` };
      }
    });

    const messages = await executeScheduledToolCalls({
      runId: 'run-scheduler',
      gateway,
      calls: [
        { id: 'r1', name: 'Read', input: { path: 'a' } },
        { id: 'r2', name: 'Read', input: { path: 'b' } },
        { id: 'w1', name: 'Write', input: { path: 'c' } }
      ]
    });

    expect(maxActiveReads).toBe(2);
    expect(events.indexOf('write:c')).toBeGreaterThan(events.indexOf('end:a'));
    expect(events.indexOf('write:c')).toBeGreaterThan(events.indexOf('end:b'));
    expect(messages.map((message) =>
      message.role === 'tool' ? message.toolCallId : '')
    ).toEqual(['r1', 'r2', 'w1']);
  });

  it('keeps MCP reads ordered because they may depend on external state', async () => {
    const gateway = new ToolGateway({
      approvalPolicy: () => ({ action: 'allow' })
    });
    let active = 0;
    let maxActive = 0;
    gateway.register({
      name: 'server__read',
      description: 'mcp read',
      risk: 'read',
      category: 'mcp:server',
      inputSchema: z.object({ id: z.number() }),
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return { content: 'ok' };
      }
    });

    await executeScheduledToolCalls({
      runId: 'run-mcp-order',
      gateway,
      calls: [
        { id: 'm1', name: 'server__read', input: { id: 1 } },
        { id: 'm2', name: 'server__read', input: { id: 2 } }
      ]
    });
    expect(maxActive).toBe(1);
  });
});

class ReadBatchClient implements LlmClient {
  readonly provider = 'openai' as const;
  private streams = 0;

  async complete(_request: LlmRequest): Promise<LlmResponse> {
    throw new Error('complete should not be used');
  }

  async *stream(_request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.streams += 1;
    if (this.streams === 1) {
      yield {
        type: 'tool-call',
        call: { id: 'r1', name: 'Read', input: { path: 'a' } }
      };
      yield {
        type: 'tool-call',
        call: { id: 'r2', name: 'Read', input: { path: 'b' } }
      };
    } else {
      yield { type: 'text-delta', text: 'done' };
    }
    yield { type: 'done' };
  }
}
