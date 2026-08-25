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
import type { AgentExecutionProfile } from './agentExecutionProfile';

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
      input: '读取并更新 README'
    });
    expect(pending.status).toBe('approval-required');
    expect(counters).toEqual({ read: 1, write: 0 });
    expect(first.exportWorkState().runCheckpoint).toMatchObject({
      executionProfileId: 'coding',
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

  it('restores the same custom profile and reapplies profile sources on approval resume', async () => {
    const counters = { read: 0, write: 0 };
    const firstContext = new SessionContext();
    const first = createRuntime(
      new ToolBatchClient(true),
      firstContext,
      counters,
      createTestProfile('work')
    );
    const pending = await first.run({
      input: '生成交付物'
    });
    expect(first.exportWorkState().runCheckpoint).toMatchObject({
      executionProfileId: 'work'
    });

    const secondContext = new SessionContext();
    expect(
      secondContext.restoreState(first.exportContextState(), {
        preserveOpenTurn: true
      })
    ).toBe(true);
    const resumedClient = new ToolBatchClient(false);
    const second = createRuntime(
      resumedClient,
      secondContext,
      counters,
      createTestProfile('work')
    );
    expect(second.restoreWorkState(first.exportWorkState())).toBe(true);

    const completed = await second.resolveToolApproval({
      runId: pending.runId,
      approved: true
    });
    expect(completed.status).toBe('completed');
    expect(
      resumedClient.requests[0]?.messages.some((message) =>
        message.content.includes('Profile source: work')
      )
    ).toBe(true);
  });

  it('rejects cross-profile and legacy non-Coding checkpoint recovery', async () => {
    const context = new SessionContext();
    const first = createRuntime(
      new ToolBatchClient(true),
      context,
      { read: 0, write: 0 }
    );
    await first.run({ input: '更新文件' });
    const workState = first.exportWorkState();

    const restoredContext = new SessionContext();
    expect(
      restoredContext.restoreState(first.exportContextState(), {
        preserveOpenTurn: true
      })
    ).toBe(true);
    const crossProfile = createRuntime(
      new ToolBatchClient(false),
      restoredContext,
      { read: 0, write: 0 },
      createTestProfile('work')
    );
    expect(crossProfile.restoreWorkState(workState)).toBe(false);
    expect(crossProfile.getPendingToolApproval()).toBeUndefined();

    const legacyContext = new SessionContext();
    expect(
      legacyContext.restoreState(first.exportContextState(), {
        preserveOpenTurn: true
      })
    ).toBe(true);
    const legacyState = structuredClone(workState);
    if (legacyState.runCheckpoint) {
      delete legacyState.runCheckpoint.executionProfileId;
    }
    const legacyWork = createRuntime(
      new ToolBatchClient(false),
      legacyContext,
      { read: 0, write: 0 },
      createTestProfile('work')
    );
    expect(legacyWork.restoreWorkState(legacyState)).toBe(false);

    const legacyCodingContext = new SessionContext();
    expect(
      legacyCodingContext.restoreState(first.exportContextState(), {
        preserveOpenTurn: true
      })
    ).toBe(true);
    const legacyCoding = createRuntime(
      new ToolBatchClient(false),
      legacyCodingContext,
      { read: 0, write: 0 }
    );
    expect(legacyCoding.restoreWorkState(legacyState)).toBe(true);
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
      runCheckpoint: {
        version: 1 as const,
        runId: 'run-missing-context',
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
  counters: { read: number; write: number },
  executionProfile?: AgentExecutionProfile
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
    risk: 'execute',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async () => {
      counters.write += 1;
      return { content: 'wrote README.md' };
    }
  });
  const runtime = new AgentRuntime({
    traceStore,
    llmClient,
    sessionContext: context,
    toolGateway: gateway,
    executionProfile,
    createRunId: () => 'run-checkpoint'
  });
  return runtime;
}

class ToolBatchClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  constructor(private readonly emitTools: boolean) {}

  async complete(_request: LlmRequest): Promise<LlmResponse> {
    throw new Error('complete should not be used');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
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

function createTestProfile(id: string): AgentExecutionProfile {
  return {
    id,
    buildSystemPrompt: ({ defaultPrompt }) => defaultPrompt,
    createCompletionPolicy: () => ({
      id: `${id}-completion`,
      assess: () => ({
        required: true,
        satisfied: true,
        status: 'passed',
        reason: 'Profile completion passed.'
      })
    }),
    getContextSources: () => ({
      sources: [
        {
          id: `${id}-source`,
          kind: 'user',
          title: 'Profile source',
          content: `Profile source: ${id}`,
          pinned: true
        }
      ]
    }),
    getToolPolicy: () => ({
      observeCodingVerificationLifecycle: false
    })
  };
}
