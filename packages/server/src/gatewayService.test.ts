import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type EventEnvelope
} from '@kross/protocol';
import { describe, expect, it } from 'vitest';

import type {
  ContainerOrchestrator,
  CreateWorkspaceContainerInput
} from './containerOrchestrator';
import { GatewayService } from './gatewayService';
import { IdleWorkspaceReaper } from './idleReaper';
import { RuntimeConfigStore } from './runtimeConfig';
import { WorkspaceRegistry, type WorkspaceRecord } from './workspaceRegistry';

class FakeOrchestrator implements ContainerOrchestrator {
  created: CreateWorkspaceContainerInput[] = [];
  stopped: string[] = [];
  stoppedManaged: string[] = [];
  removed: string[] = [];
  removedManaged: string[] = [];
  recreated: Array<{ id: string; start: boolean }> = [];
  configuredEnvironment?: Record<string, string | undefined>;
  states = new Map<
    string,
    { exists: boolean; running: boolean; needsRecreate?: boolean }
  >();
  managed: Array<{
    workspaceId: string;
    containerName: string;
    running: boolean;
  }> = [];

  async create(input: CreateWorkspaceContainerInput) {
    this.created.push(input);
    input.onProgress?.('validating', 'validate');
    input.onProgress?.('provisioning', 'provision');
    input.onProgress?.('cloning', 'clone');
    input.onProgress?.('starting', 'start');
    return {
      containerName: `container-${input.id}`,
      volumeName: `volume-${input.id}`,
      workerToken: 'worker-token'
    };
  }
  async start(): Promise<void> {}
  async stop(record: WorkspaceRecord): Promise<void> {
    this.stopped.push(record.workspace.id);
  }
  async remove(record: WorkspaceRecord): Promise<void> {
    this.removed.push(record.workspace.id);
  }
  async workerUrl(): Promise<string> {
    return 'ws://unneeded';
  }
  async inspect(record: WorkspaceRecord): Promise<{
    exists: boolean;
    running: boolean;
    needsRecreate?: boolean;
  }> {
    return this.states.get(record.workspace.id) ??
      { exists: true, running: true };
  }
  async listManaged() {
    return this.managed;
  }
  async stopManaged(containerName: string) {
    this.stoppedManaged.push(containerName);
  }
  async removeManaged(containerName: string) {
    this.removedManaged.push(containerName);
  }
  async recreate(record: WorkspaceRecord, start: boolean) {
    this.recreated.push({ id: record.workspace.id, start });
  }
  configureWorkerEnvironment(
    environment: Record<string, string | undefined>
  ) {
    this.configuredEnvironment = environment;
  }
}

describe('GatewayService', () => {
  it('creates a workspace without persisting credentials in public metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-gateway-'));
    const registry = new WorkspaceRegistry(join(root, 'workspaces.json'));
    const orchestrator = new FakeOrchestrator();
    const gateway = new GatewayService(registry, orchestrator);
    const events: EventEnvelope[] = [];

    await gateway.handle(
      {
        type: 'workspace.create',
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'r1',
        name: 'demo',
        gitUrl: 'https://user:secret@example.com/repo.git',
        credential: { type: 'https-token', token: 'top-secret' }
      } satisfies ClientCommand,
      (event) => events.push(event)
    );

    expect(orchestrator.created[0]?.credential).toEqual({
      type: 'https-token',
      token: 'top-secret'
    });
    expect(JSON.stringify(registry.list())).not.toContain('secret');
    expect(events.some((event) => event.event.type === 'request.accepted')).toBe(true);
    expect(
      events
        .filter((event) => event.event.type === 'workspace.progress')
        .map((event) =>
          event.event.type === 'workspace.progress'
            ? event.event.data.stage
            : undefined
        )
    ).toEqual([
      'validating',
      'provisioning',
      'cloning',
      'starting',
      'ready'
    ]);
  });

  it('reconciles stale registry state and stops orphaned managed workers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-reconcile-'));
    const registry = new WorkspaceRegistry(join(root, 'workspaces.json'));
    const orchestrator = new FakeOrchestrator();
    const record: WorkspaceRecord = {
      workspace: {
        id: 'w1',
        name: 'demo',
        gitUrl: 'https://example.com/repo.git',
        status: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      containerName: 'c1',
      volumeName: 'v1',
      workerToken: 'token'
    };
    registry.put(record);
    orchestrator.states.set('w1', { exists: true, running: false });
    orchestrator.managed = [
      { workspaceId: 'w1', containerName: 'c1', running: false },
      { workspaceId: 'orphan', containerName: 'orphan-container', running: true }
    ];
    const gateway = new GatewayService(registry, orchestrator);

    expect(await gateway.reconcileWorkspaces()).toEqual({
      running: 0,
      stopped: 1,
      missing: 0,
      orphaned: 1
    });
    expect(registry.get('w1')?.workspace.status).toBe('stopped');
    expect(orchestrator.removedManaged).toEqual(['orphan-container']);
  });

  it('removes worker containers but preserves registry state during shutdown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-shutdown-'));
    const registry = new WorkspaceRegistry(join(root, 'workspaces.json'));
    const orchestrator = new FakeOrchestrator();
    registry.put({
      workspace: {
        id: 'w1',
        name: 'demo',
        gitUrl: 'https://example.com/repo.git',
        status: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      containerName: 'c1',
      volumeName: 'v1',
      workerToken: 'token'
    });
    orchestrator.managed = [
      { workspaceId: 'orphan', containerName: 'orphan-container', running: true }
    ];
    const gateway = new GatewayService(registry, orchestrator);

    await gateway.close();

    expect(orchestrator.removed).toEqual(['w1']);
    expect(orchestrator.removedManaged).toEqual(['orphan-container']);
    expect(registry.get('w1')?.workspace.status).toBe('stopped');
  });

  it('recreates a missing stopped worker from its persistent volume metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-recreate-'));
    const registry = new WorkspaceRegistry(join(root, 'workspaces.json'));
    const orchestrator = new FakeOrchestrator();
    registry.put({
      workspace: {
        id: 'w1',
        name: 'demo',
        gitUrl: 'https://example.com/repo.git',
        status: 'stopped',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      containerName: 'c1',
      volumeName: 'v1',
      workerToken: 'token'
    });
    orchestrator.states.set('w1', { exists: false, running: false });
    const gateway = new GatewayService(registry, orchestrator);

    expect(await gateway.reconcileWorkspaces()).toMatchObject({
      stopped: 1,
      missing: 0
    });
    expect(orchestrator.recreated).toEqual([{ id: 'w1', start: false }]);
    expect(registry.get('w1')?.workspace.status).toBe('stopped');
  });

  it('recreates a worker that uses a stale image or shared network', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-migrate-worker-'));
    const registry = new WorkspaceRegistry(join(root, 'workspaces.json'));
    const orchestrator = new FakeOrchestrator();
    registry.put({
      workspace: {
        id: 'w1',
        name: 'demo',
        gitUrl: 'https://example.com/repo.git',
        status: 'stopped',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      containerName: 'c1',
      volumeName: 'v1',
      workerToken: 'token'
    });
    orchestrator.states.set('w1', {
      exists: true,
      running: false,
      needsRecreate: true
    });
    const gateway = new GatewayService(registry, orchestrator);

    await gateway.reconcileWorkspaces();
    expect(orchestrator.recreated).toEqual([{ id: 'w1', start: false }]);
  });

  it('applies saved provider configuration and optionally rebuilds workers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-configure-'));
    const registry = new WorkspaceRegistry(join(root, 'workspaces.json'));
    const orchestrator = new FakeOrchestrator();
    registry.put({
      workspace: {
        id: 'w1',
        name: 'demo',
        gitUrl: 'https://example.com/repo.git',
        status: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      containerName: 'c1',
      volumeName: 'v1',
      workerToken: 'token'
    });
    const runtimeConfig = new RuntimeConfigStore(
      join(root, 'provider.json'),
      {}
    );
    const gateway = new GatewayService(
      registry,
      orchestrator,
      undefined,
      undefined,
      { runtimeConfig }
    );

    const result = await gateway.updateProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'provider-secret'
    }, true);

    expect(result.provider).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      hasApiKey: true
    });
    expect(orchestrator.configuredEnvironment).toMatchObject({
      OPENAI_API_KEY: 'provider-secret',
      AGENT_LLM_MODEL: 'gpt-test'
    });
    expect(orchestrator.recreated).toEqual([{ id: 'w1', start: true }]);
  });

  it('reaps workspaces after the configured idle threshold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-reaper-'));
    const registry = new WorkspaceRegistry(join(root, 'workspaces.json'));
    const orchestrator = new FakeOrchestrator();
    registry.put({
      workspace: {
        id: 'w1',
        name: 'demo',
        gitUrl: 'https://example.com/repo.git',
        status: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z'
      },
      containerName: 'c1',
      volumeName: 'v1',
      workerToken: 'token'
    });
    const reaper = new IdleWorkspaceReaper(
      registry,
      orchestrator,
      60_000,
      10_000,
      () => Date.parse('2026-01-01T00:02:00.000Z')
    );

    expect(await reaper.sweep()).toEqual(['w1']);
    expect(registry.get('w1')?.workspace.status).toBe('stopped');
  });

  it('does not reap a workspace with an active run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-reaper-busy-'));
    const registry = new WorkspaceRegistry(join(root, 'workspaces.json'));
    const orchestrator = new FakeOrchestrator();
    registry.put({
      workspace: {
        id: 'w1',
        name: 'busy',
        gitUrl: 'https://example.com/repo.git',
        status: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z'
      },
      containerName: 'c1',
      volumeName: 'v1',
      workerToken: 'token'
    });
    const reaper = new IdleWorkspaceReaper(
      registry,
      orchestrator,
      60_000,
      10_000,
      () => Date.parse('2026-01-01T00:02:00.000Z'),
      async () => true
    );

    expect(await reaper.sweep()).toEqual([]);
    expect(registry.get('w1')?.workspace.status).toBe('ready');
    expect(orchestrator.stopped).toEqual([]);
  });
});
