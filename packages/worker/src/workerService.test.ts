import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentRuntime,
  ObservableTraceStore,
  ToolGateway,
  type AgentHostTooling,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamChunk,
  type TraceEvent,
  type TraceStore
} from '@kross/core';
import {
  eventEnvelopeSchema,
  PROTOCOL_VERSION,
  type ClientCommand,
  type EventEnvelope
} from '@kross/protocol';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { WorkerService, type RuntimeHandle } from './workerService';

class MemoryTraceStore implements TraceStore {
  events: TraceEvent[] = [];
  async append(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }
  async listRunIds(): Promise<string[]> {
    return [...new Set(this.events.map((event) => event.runId))];
  }
}

class ApprovalLlm implements LlmClient {
  readonly provider = 'openai' as const;
  readonly model = 'test-model';
  readonly thinkingEffort = 'low' as const;
  calls = 0;

  async complete(): Promise<LlmResponse> {
    throw new Error('streaming expected');
  }

  async *stream(_request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: 'tool-call',
        call: { id: 'danger-1', name: 'DangerWrite', input: { value: 'ok' } }
      };
      yield { type: 'done' };
      return;
    }
    yield { type: 'text-delta', text: '执行完成' };
    yield { type: 'done' };
  }
}

function runtimeFactory(executions: string[]): () => Promise<RuntimeHandle> {
  return async () => {
    const traceStore = new ObservableTraceStore(new MemoryTraceStore());
    const gateway = new ToolGateway({ traceStore });
    gateway.register({
      name: 'DangerWrite',
      description: 'approval test',
      risk: 'write',
      inputSchema: z.object({ value: z.string() }),
      async execute({ input }) {
        executions.push(input.value);
        return { content: input.value, summary: 'wrote value' };
      }
    });
    const runtime = new AgentRuntime({
      traceStore,
      toolGateway: gateway,
      llmClient: new ApprovalLlm(),
      workspaceRoot: process.cwd()
    });
    const tooling = {
      traceStore,
      close: async () => undefined
    } as unknown as AgentHostTooling;
    return { runtime, tooling };
  };
}

function send(
  service: WorkerService,
  command: ClientCommand,
  events: EventEnvelope[]
): Promise<void> {
  return service.handle(command, (event) => events.push(event));
}

describe('WorkerService integration', () => {
  it('deduplicates concurrent runtime loads and evicts least-recent idle sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-worker-lru-'));
    const workspace = join(root, 'repo');
    mkdirSync(workspace);
    let created = 0;
    let closed = 0;
    const factory = async () => {
      created += 1;
      const handle = await runtimeFactory([])();
      handle.tooling.close = async () => {
        closed += 1;
      };
      return handle;
    };
    const service = new WorkerService({
      workspaceId: 'w1',
      workspaceRoot: workspace,
      krossHome: join(root, '.kross'),
      runtimeFactory: factory,
      maxActiveSessions: 1,
      sessionIdleMs: Number.POSITIVE_INFINITY
    });
    const events: EventEnvelope[] = [];
    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'create-1',
      type: 'session.create',
      workspaceId: 'w1'
    }, events);
    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'create-2',
      type: 'session.create',
      workspaceId: 'w1'
    }, events);
    expect(created).toBe(2);
    expect(closed).toBe(1);

    const firstSession = events.find(
      (event) =>
        event.correlationId === 'create-1' &&
        event.event.type === 'session.snapshot'
    );
    if (firstSession?.event.type !== 'session.snapshot') {
      throw new Error('missing first session');
    }
    const resumes: EventEnvelope[] = [];
    await Promise.all([
      send(service, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'resume-a',
        type: 'session.resume',
        workspaceId: 'w1',
        sessionId: firstSession.event.data.summary.id,
        lastSeq: 0
      }, resumes),
      send(service, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'resume-b',
        type: 'session.resume',
        workspaceId: 'w1',
        sessionId: firstSession.event.data.summary.id,
        lastSeq: 0
      }, resumes)
    ]);
    expect(created).toBe(3);
    await service.close();
  });

  it('lists configured models and deletes an idle session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-worker-management-'));
    const workspace = join(root, 'repo');
    mkdirSync(workspace);
    const service = new WorkerService({
      workspaceId: 'w1',
      workspaceRoot: workspace,
      krossHome: join(root, '.kross'),
      env: {
        AGENT_LLM_PROVIDER: 'openai',
        AGENT_LLM_MODEL: 'custom-model'
      },
      runtimeFactory: runtimeFactory([])
    });
    const events: EventEnvelope[] = [];
    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'models',
      type: 'models.list',
      workspaceId: 'w1'
    }, events);
    const modelEvent = events.find(
      (event) => event.event.type === 'models.list'
    );
    expect(
      modelEvent?.event.type === 'models.list'
        ? modelEvent.event.data
        : []
    ).toContainEqual(
      expect.objectContaining({ id: 'custom-model', provider: 'OpenAI' })
    );

    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'create-delete',
      type: 'session.create',
      workspaceId: 'w1'
    }, events);
    const snapshot = events.find(
      (event) =>
        event.correlationId === 'create-delete' &&
        event.event.type === 'session.snapshot'
    );
    if (snapshot?.event.type !== 'session.snapshot') {
      throw new Error('missing created session');
    }
    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'delete',
      type: 'session.delete',
      workspaceId: 'w1',
      sessionId: snapshot.event.data.summary.id
    }, events);
    expect(
      events.find(
        (event) =>
          event.correlationId === 'delete' &&
          event.event.type === 'session.deleted'
      )?.event
    ).toMatchObject({
      type: 'session.deleted',
      data: { sessionId: snapshot.event.data.summary.id }
    });
    await service.close();
  });

  it('rejects new tasks when the workspace exceeds its disk quota', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-worker-quota-'));
    const workspace = join(root, 'repo');
    mkdirSync(workspace);
    const executions: string[] = [];
    let diskChecks = 0;
    const service = new WorkerService({
      workspaceId: 'w1',
      workspaceRoot: workspace,
      krossHome: join(root, '.kross'),
      runtimeFactory: runtimeFactory(executions),
      diskLimitBytes: 10 * 1024,
      diskUsageBytes: async () => {
        diskChecks += 1;
        return 12 * 1024;
      }
    });
    const events: EventEnvelope[] = [];
    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'create-quota',
      type: 'session.create',
      workspaceId: 'w1'
    }, events);
    const snapshot = events.find(
      (event) => event.event.type === 'session.snapshot'
    );
    if (snapshot?.event.type !== 'session.snapshot') {
      throw new Error('missing session snapshot');
    }

    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'input-over-quota',
      type: 'session.input',
      workspaceId: 'w1',
      sessionId: snapshot.event.data.summary.id,
      input: '执行任务',
      mode: 'auto'
    }, events);

    expect(
      events.find(
        (event) =>
          event.event.type === 'request.error' &&
          event.event.requestId === 'input-over-quota'
      )?.event
    ).toMatchObject({
      type: 'request.error',
      code: 'WORKSPACE_DISK_QUOTA_EXCEEDED'
    });
    expect(executions).toEqual([]);
    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'input-over-quota-again',
      type: 'session.input',
      workspaceId: 'w1',
      sessionId: snapshot.event.data.summary.id,
      input: '再次执行任务',
      mode: 'auto'
    }, events);
    expect(diskChecks).toBe(1);
    await service.close();
  });

  it('runs, pauses for approval, resumes, persists and replays the session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-worker-'));
    const workspace = join(root, 'repo');
    mkdirSync(workspace);
    const krossHome = join(root, '.kross');
    const executions: string[] = [];
    const service = new WorkerService({
      workspaceId: 'w1',
      workspaceRoot: workspace,
      krossHome,
      runtimeFactory: runtimeFactory(executions)
    });
    const events: EventEnvelope[] = [];

    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'create',
      type: 'session.create',
      workspaceId: 'w1'
    }, events);
    const snapshotEvent = events.find(
      (event) => event.event.type === 'session.snapshot'
    );
    if (snapshotEvent?.event.type !== 'session.snapshot') {
      throw new Error('missing session snapshot');
    }
    expect(snapshotEvent.correlationId).toBe('create');
    expect(
      events.find(
        (event) =>
          event.event.type === 'request.accepted' &&
          event.event.requestId === 'create'
      )?.correlationId
    ).toBe('create');
    const sessionId = snapshotEvent.event.data.summary.id;

    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'rename',
      type: 'session.rename',
      workspaceId: 'w1',
      sessionId,
      title: '审批流程测试'
    }, events);
    expect(
      events.find(
        (event) =>
          event.event.type === 'session.updated' &&
          event.event.data.id === sessionId
      )?.event
    ).toMatchObject({
      type: 'session.updated',
      data: { title: '审批流程测试' }
    });

    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'input',
      type: 'session.input',
      workspaceId: 'w1',
      sessionId,
      input: '请使用 DangerWrite 工具完成任务',
      mode: 'auto'
    }, events);
    const approval = events.find(
      (event) => event.event.type === 'approval.pending'
    );
    if (approval?.event.type !== 'approval.pending') {
      throw new Error('missing approval event');
    }
    expect(executions).toEqual([]);

    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'approve',
      type: 'session.approval',
      workspaceId: 'w1',
      sessionId,
      runId: approval.event.data.runId,
      approved: true
    }, events);
    expect(executions).toEqual(['ok']);
    expect(
      events.some(
        (event) =>
          event.event.type === 'stream' &&
          event.event.data.type === 'text-delta' &&
          event.event.data.text === '执行完成'
      )
    ).toBe(true);
    expect(
      events
        .filter((event) => event.event.type === 'stream')
        .every((event) => event.correlationId === undefined)
    ).toBe(true);
    const completedToolSnapshot = [...events].reverse().find(
      (event) =>
        event.event.type === 'session.snapshot' &&
        event.event.data.messages.some((message) => message.tool?.callId === 'danger-1')
    );
    expect(
      completedToolSnapshot?.event.type === 'session.snapshot'
        ? completedToolSnapshot.event.data.messages.find(
            (message) => message.tool?.callId === 'danger-1'
          )
        : undefined
    ).toMatchObject({
      from: 'tool',
      tool: {
        callId: 'danger-1',
        name: 'DangerWrite',
        status: 'completed',
        summary: 'wrote value'
      }
    });

    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'plan',
      type: 'session.input',
      workspaceId: 'w1',
      sessionId,
      input: '请先制定一个实现计划',
      mode: 'plan'
    }, events);
    const planSnapshot = [...events].reverse().find(
      (event) =>
        event.event.type === 'session.snapshot' &&
        event.event.data.pendingPlan !== undefined
    );
    expect(
      planSnapshot?.event.type === 'session.snapshot' &&
        planSnapshot.event.data.pendingPlan?.goal
    ).toBe('请先制定一个实现计划');
    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'reject-plan',
      type: 'session.plan-approval',
      workspaceId: 'w1',
      sessionId,
      approved: false
    }, events);
    const rejectedSnapshot = events.at(-1);
    expect(
      rejectedSnapshot?.event.type === 'session.snapshot' &&
        rejectedSnapshot.event.data.pendingPlan
    ).toBeUndefined();

    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'plan-2',
      type: 'session.input',
      workspaceId: 'w1',
      sessionId,
      input: '计划并实现第二个任务',
      mode: 'plan'
    }, events);
    await send(service, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'approve-plan',
      type: 'session.plan-approval',
      workspaceId: 'w1',
      sessionId,
      approved: true,
      input: '计划并实现第二个任务'
    }, events);
    const approvedPlanSnapshot = [...events].reverse().find(
      (event) => event.event.type === 'session.snapshot'
    );
    expect(
      approvedPlanSnapshot?.event.type === 'session.snapshot'
        ? approvedPlanSnapshot.event.data.messages.filter(
            (message) =>
              message.from === 'user' && message.text === '计划并实现第二个任务'
          )
        : []
    ).toHaveLength(1);
    for (const event of events) {
      expect(() => eventEnvelopeSchema.parse(event)).not.toThrow();
    }

    const lastSeq = events.at(-1)?.seq ?? 0;
    await service.close();

    const restored = new WorkerService({
      workspaceId: 'w1',
      workspaceRoot: workspace,
      krossHome,
      runtimeFactory: runtimeFactory(executions)
    });
    const resumed: EventEnvelope[] = [];
    await send(restored, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'resume',
      type: 'session.resume',
      workspaceId: 'w1',
      sessionId,
      lastSeq: Math.max(0, lastSeq - 2)
    }, resumed);

    expect(resumed.some((event) => event.event.type === 'replay.complete')).toBe(true);
    const restoredSnapshot = resumed.find(
      (event) => event.event.type === 'session.snapshot'
    );
    expect(
      restoredSnapshot?.event.type === 'session.snapshot' &&
        restoredSnapshot.event.data.messages.some(
          (message) => message.from === 'agent' && message.text === '执行完成'
        )
    ).toBe(true);
    expect(
      restoredSnapshot?.event.type === 'session.snapshot'
        ? restoredSnapshot.event.data.messages.filter(
            (message) => message.tool?.callId === 'danger-1'
          )
        : []
    ).toEqual([
      expect.objectContaining({
        tool: expect.objectContaining({
          name: 'DangerWrite',
          status: 'completed'
        })
      })
    ]);
    await restored.close();
  });
});
