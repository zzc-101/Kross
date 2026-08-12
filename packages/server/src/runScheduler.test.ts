import { describe, expect, it, vi } from 'vitest';

import type { QueryResult, SqlClient, SqlExecutor, TransactionRunner } from './database';
import type { OrchestratorClient, OrchestratorLaunchRequest } from './orchestratorClient';
import { RunScheduler } from './runScheduler';

describe('RunScheduler', () => {
  it('claims a lease, issues a run token and launches the exact generation', async () => {
    const fixture = createFixture();
    const launched: OrchestratorLaunchRequest[] = [];
    fixture.orchestrator.launch = vi.fn(async (request) => {
      launched.push(request);
      return handle(request.runId, request.generation);
    });

    await expect(fixture.scheduler.runOnce()).resolves.toBe(true);

    expect(fixture.issueRunToken).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', generation: 4, leaseId: 'lease-1' }),
      30_000
    );
    expect(launched[0]).toEqual(expect.objectContaining({
      runId: 'run-1', generation: 4, leaseId: 'lease-1', runToken: 'run-token',
      runSpecUrl: 'http://server:8787/internal/v2/workers/register',
      networkAccess: 'connector_proxy_only'
    }));
    expect(launched[0]?.resourceLimits).toEqual(limits());
    expect(fixture.queries.some((query) => query.includes("status = 'provisioning'"))).toBe(true);
  });

  it('revokes the issued token and releases the lease after launch failure', async () => {
    const fixture = createFixture();
    fixture.orchestrator.launch = vi.fn(async () => { throw new Error('orchestrator unavailable'); });

    await expect(fixture.scheduler.runOnce()).rejects.toThrow('orchestrator unavailable');

    expect(fixture.queries.some((query) => query.includes('UPDATE worker_run_tokens SET revoked_at'))).toBe(true);
    expect(fixture.queries.some((query) => query.includes("status = 'released'"))).toBe(true);
  });

  it('calls Orchestrator cancel for the active generation', async () => {
    const fixture = createFixture({ cancelGeneration: 7 });
    await fixture.scheduler.cancel('run-1', 'org-1');
    expect(fixture.orchestrator.cancel).toHaveBeenCalledWith('run-1', 7);
  });

  it('finalizes a queued cancellation without launching a container', async () => {
    const fixture = createFixture({ cancelGeneration: undefined });
    await fixture.scheduler.cancel('run-1', 'org-1');
    expect(fixture.orchestrator.cancel).not.toHaveBeenCalled();
    expect(fixture.queries.some((query) => query.includes("status = 'cancelled'"))).toBe(true);
  });
});

function createFixture(options: { cancelGeneration?: number } = {}) {
  const queries: string[] = [];
  let claimStep = 0;
  const query = vi.fn(async (text: string): Promise<QueryResult> => {
    queries.push(text);
    if (text.includes('SELECT run_id, organization_id FROM run_leases')) {
      claimStep += 1;
      return { rows: [{ run_id: 'run-1', organization_id: 'org-1' }], rowCount: 1 };
    }
    if (text.includes("UPDATE run_leases SET status = 'leased'")) {
      return { rows: [{ lease_id: 'lease-1', organization_id: 'org-1', run_id: 'run-1', lease_owner: 'server-1', generation: 4, lease_expires_at: '2026-08-12T00:01:00.000Z' }], rowCount: 1 };
    }
    if (text.includes('SELECT resource_limits, permission_policy')) {
      return { rows: [{ resource_limits: limits(), permission_policy: { networkAccess: 'connector_proxy_only' } }], rowCount: 1 };
    }
    if (text.includes("SET status = 'provisioning'")) return { rows: [{ id: 'run-1' }], rowCount: 1 };
    if (text.includes('SELECT l.generation')) {
      return options.cancelGeneration === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ generation: options.cancelGeneration }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() } as unknown as SqlClient;
  const transactions: TransactionRunner = { transaction: async (operation) => operation(client) };
  const sql = { query } as unknown as SqlExecutor;
  const issueRunToken = vi.fn(async () => ({ token: 'run-token', expiresAt: '2026-08-12T00:00:30.000Z' }));
  const orchestrator: OrchestratorClient = {
    launch: vi.fn(async (request) => handle(request.runId, request.generation)),
    cancel: vi.fn(async (runId, generation) => ({ ...handle(runId, generation), state: 'exited' as const }))
  };
  const scheduler = new RunScheduler(sql, transactions, { issueRunToken }, orchestrator, {
    owner: 'server-1', publicBaseUrl: 'http://server:8787', retryDelayMs: 100
  });
  return { scheduler, orchestrator, issueRunToken, queries };
}

function handle(runId: string, generation: number) {
  return { runId, generation, containerId: 'container-1', containerName: 'container-1', volumeName: 'volume-1', deadlineAt: '2026-08-12T01:00:00.000Z' };
}
function limits() { return { cpuMillis: 1_000, memoryBytes: 1024, maxPids: 64, diskBytes: 4096, maxDurationMs: 60_000, maxSourceBytes: 4096, maxArtifactBytes: 4096, maxEventPayloadBytes: 4096 }; }
