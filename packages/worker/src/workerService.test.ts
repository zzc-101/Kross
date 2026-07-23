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
  it('rejects new tasks when the workspace exceeds its disk quota', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-worker-quota-'));
    const workspace = join(root, 'repo');
    mkdirSync(workspace);
    const executions: string[] = [];
    const service = new WorkerService({
      workspaceId: 'w1',
      workspaceRoot: workspace,
      krossHome: join(root, '.kross'),
      runtimeFactory: runtimeFactory(executions),
      diskLimitBytes: 10 * 1024,
      diskUsageBytes: async () => 12 * 1024
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
    await restored.close();
  });
});
