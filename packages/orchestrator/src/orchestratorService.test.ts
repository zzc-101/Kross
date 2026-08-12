import { describe, expect, it } from 'vitest';

import { ScopeAuthorizer } from './authorization';
import { StaleGenerationError } from './errors';
import { OrchestratorService } from './orchestratorService';
import type {
  AuthorizationContext,
  BackendHandle,
  BackendInspection,
  ContainerBackend,
  RunLaunchRequest
} from './types';

class FakeBackend implements ContainerBackend {
  readonly executions: BackendInspection[] = [];
  readonly launched: RunLaunchRequest[] = [];
  readonly terminated: string[] = [];
  readonly removed: string[] = [];
  orphanReaps = 0;
  failLaunch = false;

  async launch(request: RunLaunchRequest): Promise<BackendHandle> {
    this.launched.push(structuredClone(request));
    if (this.failLaunch) throw new Error('start failed');
    const handle: BackendInspection = {
      runId: request.runId,
      generation: request.generation,
      containerId: `${request.runId}-${request.generation}`,
      containerName: `container-${request.runId}-${request.generation}`,
      volumeName: `volume-${request.runId}-${request.generation}`,
      networkName: `network-${request.runId}-${request.generation}`,
      deadlineAt: new Date(Date.now() + request.resourceLimits.maxDurationMs).toISOString(),
      state: 'running'
    };
    this.executions.push(handle);
    return handle;
  }

  async inspect(handle: BackendHandle): Promise<BackendInspection> {
    return this.executions.find((item) => item.containerId === handle.containerId) ?? {
      ...handle,
      state: 'missing'
    };
  }

  async terminate(handle: BackendHandle): Promise<void> {
    this.terminated.push(handle.containerId);
    const execution = this.executions.find((item) => item.containerId === handle.containerId);
    if (execution) execution.state = 'exited';
  }

  async remove(handle: BackendHandle): Promise<void> {
    this.removed.push(handle.containerId);
    const index = this.executions.findIndex((item) => item.containerId === handle.containerId);
    if (index >= 0) this.executions.splice(index, 1);
  }

  async listManaged(): Promise<BackendInspection[]> {
    return [...this.executions];
  }

  async reapInfrastructureOrphans(): Promise<number> {
    this.orphanReaps += 1;
    return 0;
  }

  async health(): Promise<boolean> {
    return true;
  }
}

const context: AuthorizationContext = {
  principal: {
    serviceId: 'server',
    scopes: ['run:launch', 'run:cancel', 'run:inspect', 'run:reap']
  }
};

describe('OrchestratorService', () => {
  it('launches idempotently and forwards exact resource limits', async () => {
    const backend = new FakeBackend();
    const service = new OrchestratorService(backend, new ScopeAuthorizer());
    const request = launchRequest('run-1', 1);

    const first = await service.launch(context, request);
    const replay = await service.launch(context, request);

    expect(replay).toMatchObject(first);
    expect(backend.launched).toHaveLength(1);
    expect(backend.launched[0]?.resourceLimits).toEqual(request.resourceLimits);
  });

  it('stops and removes an old generation before launching a new one', async () => {
    const backend = new FakeBackend();
    const service = new OrchestratorService(backend, new ScopeAuthorizer());
    await service.launch(context, launchRequest('run-1', 1));

    const next = await service.launch(context, launchRequest('run-1', 2));

    expect(next.generation).toBe(2);
    expect(backend.terminated).toEqual(['run-1-1']);
    expect(backend.removed).toEqual(['run-1-1']);
    await expect(
      service.launch(context, launchRequest('run-1', 1))
    ).rejects.toBeInstanceOf(StaleGenerationError);
  });

  it('cancels only the requested generation', async () => {
    const backend = new FakeBackend();
    const service = new OrchestratorService(backend, new ScopeAuthorizer());
    await service.launch(context, launchRequest('run-1', 3));

    const result = await service.cancel(context, 'run-1', 3);

    expect(result.state).toBe('exited');
    expect(backend.terminated).toEqual(['run-1-3']);
  });

  it('reaps terminal, timed-out, orphaned and stale-generation executions', async () => {
    const backend = new FakeBackend();
    const service = new OrchestratorService(backend, new ScopeAuthorizer());
    for (const [runId, generation] of [
      ['terminal', 1],
      ['timeout', 1],
      ['orphan', 1],
      ['stale', 1],
      ['active', 2]
    ] as const) {
      await service.launch(context, launchRequest(runId, generation));
    }
    backend.executions.find((item) => item.runId === 'timeout')!.deadlineAt =
      '2026-01-01T00:00:00.000Z';

    const result = await service.reap(context, {
      activeRuns: [
        { runId: 'timeout', generation: 1 },
        { runId: 'stale', generation: 2 },
        { runId: 'active', generation: 2 }
      ],
      terminalRunIds: ['terminal'],
      now: '2026-08-12T00:00:00.000Z'
    });

    expect(result.removed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'terminal', reason: 'terminal' }),
        expect.objectContaining({ runId: 'timeout', reason: 'timeout' }),
        expect.objectContaining({ runId: 'orphan', reason: 'orphan' }),
        expect.objectContaining({ runId: 'stale', reason: 'stale_generation' })
      ])
    );
    expect(backend.executions.map((item) => item.runId)).toEqual(['active']);
    expect(backend.orphanReaps).toBe(1);
  });

  it('does not retain a failed launch as an idempotent success', async () => {
    const backend = new FakeBackend();
    const service = new OrchestratorService(backend, new ScopeAuthorizer());
    backend.failLaunch = true;
    await expect(
      service.launch(context, launchRequest('run-retry', 1))
    ).rejects.toThrow('start failed');
    backend.failLaunch = false;
    await expect(
      service.launch(context, launchRequest('run-retry', 1))
    ).resolves.toMatchObject({ runId: 'run-retry' });
    expect(backend.launched).toHaveLength(2);
  });

  it('rejects callers without the required scope', async () => {
    const service = new OrchestratorService(
      new FakeBackend(),
      new ScopeAuthorizer()
    );
    await expect(
      service.launch(
        { principal: { serviceId: 'reader', scopes: ['run:inspect'] } },
        launchRequest('run-1', 1)
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

function launchRequest(runId: string, generation: number): RunLaunchRequest {
  return {
    runId,
    generation,
    leaseId: `lease-${generation}`,
    runToken: 'r'.repeat(48),
    runSpecUrl: 'https://server.internal/v2/internal/run-spec',
    tokenExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    networkAccess: 'connector_proxy_only',
    resourceLimits: {
      cpuMillis: 1_500,
      memoryBytes: 512 * 1024 * 1024,
      maxPids: 128,
      diskBytes: 2 * 1024 * 1024 * 1024,
      maxDurationMs: 30 * 60_000,
      maxSourceBytes: 100 * 1024 * 1024,
      maxArtifactBytes: 100 * 1024 * 1024,
      maxEventPayloadBytes: 64 * 1024
    }
  };
}
