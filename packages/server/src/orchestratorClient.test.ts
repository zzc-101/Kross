import { describe, expect, it, vi } from 'vitest';

import { HttpOrchestratorClient } from './orchestratorClient';

describe('HttpOrchestratorClient', () => {
  it('uses the shared Bearer secret and forwards lease-bound launch input', async () => {
    const fetcher = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) =>
      new Response(JSON.stringify({
        runId: 'run-1', generation: 3, containerId: 'container-1',
        containerName: 'kross-run-1', volumeName: 'volume-1',
        deadlineAt: '2026-08-12T01:00:00.000Z'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const client = new HttpOrchestratorClient(
      'http://orchestrator:8790', 's'.repeat(40), fetcher
    );

    await client.launch({
      runId: 'run-1', generation: 3, leaseId: 'lease-1', runToken: 'run-secret',
      runSpecUrl: 'http://server:8787/internal/v2/workers/register',
      tokenExpiresAt: '2026-08-12T00:01:00.000Z', networkAccess: 'disabled',
      resourceLimits: limits()
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://orchestrator:8790/internal/runs/launch');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'s'.repeat(40)}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      runId: 'run-1', generation: 3, leaseId: 'lease-1', runToken: 'run-secret'
    });
  });

  it('surfaces structured Orchestrator failures', async () => {
    const client = new HttpOrchestratorClient(
      'http://orchestrator:8790', 's'.repeat(40),
      async () => new Response(JSON.stringify({ error: { code: 'STALE_RUN_GENERATION', message: 'stale' } }), { status: 409 })
    );
    await expect(client.cancel('run-1', 1)).rejects.toMatchObject({
      status: 409, code: 'STALE_RUN_GENERATION'
    });
  });
});

function limits() {
  return {
    cpuMillis: 1_000, memoryBytes: 1024, maxPids: 64, diskBytes: 4096,
    maxDurationMs: 60_000, maxSourceBytes: 4096, maxArtifactBytes: 4096,
    maxEventPayloadBytes: 4096
  };
}
