import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AgentExecutionProfile, AgentResult, AgentRunStreamEvent } from '@kross/core';
import type { ArtifactSnapshot, RunSpec, WorkerRunEventEnvelope } from '@kross/protocol';
import { FileCheckpointStore, type SourceDownloadAdapter } from '@kross/work-runtime';
import { RunExecutor } from './runExecutor';
import { createRunSpec } from './testFixtures';
import type { WorkAgentRuntime, WorkRuntimeFactory } from './coreRuntimeFactory';
import type { ArtifactReservation, WorkerControlCommand, WorkerControlTransport, WorkerLeaseIdentity } from './transport';

const lease: WorkerLeaseIdentity = { workerId: 'worker1', runId: 'run1', generation: 1, leaseId: 'lease1' };
const downloader: SourceDownloadAdapter = { downloadToFile: vi.fn() };

describe('RunExecutor', () => {
  it('completes a general run with monotonic metadata-only events', async () => {
    const transport = new FakeTransport(createRunSpec());
    const executor = new RunExecutor({
      lease, runToken: 'short-lived-token', physicalWorkRoot: await tempRoot(), transport, downloader,
      runtimeFactory: fakeFactory([
        { type: 'text-delta', text: 'Done' },
        { type: 'result', result: result('completed', 'Done') }
      ])
    });
    const outcome = await executor.execute();
    expect(outcome.status).toBe('completed');
    expect(transport.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(transport.events.at(-1)?.event.type).toBe('run.terminal');
    expect(JSON.stringify(transport.events)).not.toContain('short-lived-token');
  });

  it('rejects a stale generation before creating the runtime', async () => {
    const factory = fakeFactory([]);
    const executor = new RunExecutor({
      lease, runToken: 'token', physicalWorkRoot: await tempRoot(),
      transport: new FakeTransport(createRunSpec({ generation: 2, leaseId: 'lease2' })), downloader, runtimeFactory: factory
    });
    await expect(executor.execute()).rejects.toThrow('RunSpec does not match');
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('turns a matching cancel command into a cancelled terminal result', async () => {
    const transport = new FakeTransport(createRunSpec());
    const factory = fakeFactory([], async function* (input) {
      transport.issue({ type: 'cancel', runId: 'run1', generation: 1, reason: 'user cancelled' });
      await Promise.resolve();
      if (input.signal?.aborted) throw input.signal.reason;
    });
    const outcome = await new RunExecutor({
      lease, runToken: 'token', physicalWorkRoot: await tempRoot(), transport, downloader, runtimeFactory: factory
    }).execute();
    expect(outcome.status).toBe('cancelled');
    expect(transport.events.at(-1)?.event).toMatchObject({ type: 'run.terminal', terminal: { status: 'cancelled' } });
  });

  it('persists a checkpoint and does not emit completed while approval is pending', async () => {
    const transport = new FakeTransport(createRunSpec());
    const outcome = await new RunExecutor({
      lease, runToken: 'token', physicalWorkRoot: await tempRoot(), transport, downloader,
      runtimeFactory: fakeFactory([{ type: 'result', result: result('approval-required', 'Approval required') }])
    }).execute();
    expect(outcome.status).toBe('waiting_for_approval');
    expect(transport.events.some((event) => event.event.type === 'run.checkpoint_updated')).toBe(true);
    expect(transport.events.some((event) => event.event.type === 'run.terminal')).toBe(false);
  });

  it('restores a matching checkpoint before continuing the run', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'checkpoint'), { recursive: true });
    const saved = await new FileCheckpointStore(join(root, 'checkpoint')).save({
      version: 1,
      runId: 'run1',
      generation: 1,
      contextState: { context: true },
      workState: { work: true },
      savedAt: '2026-08-12T00:00:00.000Z'
    });
    const transport = new FakeTransport(createRunSpec({ resumeCheckpointKey: saved.key }));
    const restoreContextState = vi.fn(() => true);
    const restoreWorkState = vi.fn(() => true);
    const runtime = fakeRuntime([{ type: 'result', result: result('completed', 'Recovered') }]);
    runtime.restoreContextState = restoreContextState;
    runtime.restoreWorkState = restoreWorkState;
    const runtimeFactory: WorkRuntimeFactory = {
      create: async () => ({ runtime, close: async () => {} })
    };
    const outcome = await new RunExecutor({
      lease, runToken: 'token', physicalWorkRoot: root, transport, downloader, runtimeFactory
    }).execute();
    expect(outcome.status).toBe('completed');
    expect(restoreContextState).toHaveBeenCalledWith({ context: true });
    expect(restoreWorkState).toHaveBeenCalledWith({ work: true });
  });
});

class FakeTransport implements WorkerControlTransport {
  readonly events: WorkerRunEventEnvelope[] = [];
  private listener?: (command: WorkerControlCommand) => void;
  constructor(private readonly runSpec: RunSpec) {}
  async register() { return { workerSessionId: 'session1', heartbeatIntervalMs: 60_000, runSpec: this.runSpec }; }
  async sendEvent(input: { envelope: WorkerRunEventEnvelope }) {
    const existing = this.events.find((event) => event.seq === input.envelope.seq);
    if (!existing) this.events.push(input.envelope);
    return { acceptedThroughSeq: input.envelope.seq };
  }
  async heartbeat() { return { leaseExpiresAt: '2099-08-12T00:00:00.000Z', generation: 1, leaseId: 'lease1' }; }
  async release() {}
  async reserveArtifact(): Promise<ArtifactReservation> { throw new Error('No artifacts expected'); }
  async uploadArtifact(): Promise<{ etag?: string }> { throw new Error('No artifacts expected'); }
  async commitArtifact(): Promise<ArtifactSnapshot> { throw new Error('No artifacts expected'); }
  subscribe(listener: (command: WorkerControlCommand) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  issue(command: WorkerControlCommand) { this.listener?.(command); }
}

function fakeFactory(
  events: AgentRunStreamEvent[],
  generator?: (input: Parameters<WorkAgentRuntime['runStreaming']>[0]) => AsyncGenerator<AgentRunStreamEvent>
): WorkRuntimeFactory & { create: ReturnType<typeof vi.fn> } {
  const runtime = fakeRuntime(events, generator);
  return { create: vi.fn(async (_input: { runSpec: RunSpec; workspaceRoot: string; executionProfile: AgentExecutionProfile }) => ({ runtime, close: async () => {} })) };
}

function fakeRuntime(
  events: AgentRunStreamEvent[],
  generator?: (input: Parameters<WorkAgentRuntime['runStreaming']>[0]) => AsyncGenerator<AgentRunStreamEvent>
): WorkAgentRuntime {
  return {
    async *runStreaming(input) {
      if (generator) { yield* generator(input); return; }
      for (const event of events) yield event;
    },
    async resolveToolApproval() { return result('completed', 'resumed'); },
    exportContextState: () => ({ version: 1 }),
    exportWorkState: () => ({ version: 1 }),
    restoreContextState: () => true,
    restoreWorkState: () => true
  };
}

function result(status: AgentResult['status'], summary: string): AgentResult {
  return {
    runId: 'run1', mode: 'auto', status, summary,
    ...(status === 'approval-required'
      ? { cancellationReason: 'approval-gate' as const, pendingApproval: { runId: 'run1', toolCallId: 'tool1', toolName: 'Send', risk: 'write', inputPreview: '{}' } }
      : {}),
    report: { changedFiles: [], evidence: [], risks: [], verification: { status: 'not-needed', commands: [], evidence: [] } }
  };
}

async function tempRoot(): Promise<string> { return mkdtemp(join(tmpdir(), 'kross-worker-')); }
