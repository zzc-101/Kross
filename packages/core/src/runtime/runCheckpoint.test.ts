import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SessionContext } from '../context/sessionContext';
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk
} from '../llm/types';
import { ToolGateway } from '../tools/toolGateway';
import { AgentRuntime } from './agentRuntime';
import { InMemoryTraceStore } from './agentRuntime.testSupport';

describe('run checkpoint recovery', () => {
  it('restores an approval boundary without replaying completed calls', async () => {
    const counters = { read: 0, write: 0 };
    const firstContext = new SessionContext();
    const first = createRuntime(
      new ToolBatchClient(true),
      firstContext,
      counters
    );

    const pending = await first.run({
      input: '读取并更新 README',
      requestedMode: 'auto'
    });
    expect(pending.status).toBe('approval-required');
    expect(counters).toEqual({ read: 1, write: 0 });
    expect(first.exportWorkState().runCheckpoint).toMatchObject({
      status: 'awaiting-approval',
      completedCallIds: ['read-1'],
      pendingCall: { id: 'write-1' }
    });

    const secondContext = new SessionContext();
    expect(
      secondContext.restoreState(first.exportContextState(), {
        preserveOpenTurn: true
      })
    ).toBe(true);
    const second = createRuntime(
      new ToolBatchClient(false),
      secondContext,
      counters
    );
    expect(second.restoreWorkState(first.exportWorkState())).toBe(true);
    expect(second.getPendingToolApproval()).toMatchObject({
      runId: pending.runId,
      toolCallId: 'write-1'
    });

    const completed = await second.resolveToolApproval({
      runId: pending.runId,
      approved: true
    });
    expect(completed).toMatchObject({ status: 'completed', summary: '更新完成' });
    expect(counters).toEqual({ read: 1, write: 1 });
    expect(second.exportWorkState().runCheckpoint).toBeUndefined();
  });

  it('refuses a resumable checkpoint when its open-turn evidence is missing', () => {
    const sourceContext = new SessionContext();
    const source = createRuntime(
      new ToolBatchClient(false),
      sourceContext,
      { read: 0, write: 0 }
    );
    const invalid = {
      version: 1 as const,
      todos: [],
      sessionMode: 'auto' as const,
      runCheckpoint: {
        version: 1 as const,
        runId: 'run-missing-context',
        mode: 'auto' as const,
        originalUserInput: 'write',
        status: 'awaiting-approval' as const,
        phase: 'act' as const,
        iteration: 1,
        verificationFollowupCount: 0,
        completedCallIds: [],
        pendingCall: { id: 'write-1', name: 'fs.write', input: {} },
        remainingCalls: [],
        pendingApproval: {
          runId: 'run-missing-context',
          toolCallId: 'write-1',
          toolName: 'fs.write',
          risk: 'write' as const,
          inputPreview: '{}'
        },
        updatedAt: new Date().toISOString()
      }
    };

    expect(source.restoreWorkState(invalid)).toBe(false);
    expect(source.getPendingToolApproval()).toBeUndefined();
  });
});

function createRuntime(
  llmClient: LlmClient,
  context: SessionContext,
  counters: { read: number; write: number }
): AgentRuntime {
  const traceStore = new InMemoryTraceStore();
  const gateway = new ToolGateway({ traceStore });
  gateway.register({
    name: 'fs.read',
    description: 'read',
    risk: 'read',
    inputSchema: z.object({ path: z.string() }),
    execute: async () => {
      counters.read += 1;
      return { content: 'old content' };
    }
  });
  gateway.register({
    name: 'fs.write',
    description: 'write',
    risk: 'write',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async () => {
      counters.write += 1;
      return { content: 'wrote README.md' };
    }
  });
  return new AgentRuntime({
    traceStore,
    llmClient,
    sessionContext: context,
    toolGateway: gateway,
    createRunId: () => 'run-checkpoint'
  });
}

class ToolBatchClient implements LlmClient {
  readonly provider = 'openai' as const;

  constructor(private readonly emitTools: boolean) {}

  async complete(_request: LlmRequest): Promise<LlmResponse> {
    throw new Error('complete should not be used');
  }

  async *stream(_request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    if (this.emitTools) {
      yield {
        type: 'tool-call',
        call: { id: 'read-1', name: 'fs.read', input: { path: 'README.md' } }
      };
      yield {
        type: 'tool-call',
        call: {
          id: 'write-1',
          name: 'fs.write',
          input: { path: 'README.md', content: 'new content' }
        }
      };
    } else {
      yield { type: 'text-delta', text: '更新完成' };
    }
    yield { type: 'done' };
  }
}
