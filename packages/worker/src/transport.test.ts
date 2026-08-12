import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@kross/protocol';
import { FetchWorkerControlTransport } from './transport';
import { createRunSpec } from './testFixtures';

const lease = { workerId: 'worker1', runId: 'run1', generation: 1, leaseId: 'lease1' };

describe('FetchWorkerControlTransport', () => {
  it('uses Bearer Run token and validates the registered RunSpec response', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) =>
      Response.json({
        protocolVersion: PROTOCOL_VERSION,
        messageId: 'response1',
        sentAt: '2026-08-12T00:00:00.000Z',
        type: 'worker.registered',
        workerSessionId: 'session1',
        heartbeatIntervalMs: 10_000,
        runSpec: createRunSpec()
      })
    );
    const transport = new FetchWorkerControlTransport({
      controlPlaneUrl: 'https://control.example.test',
      runSpecUrl: 'https://control.example.test/internal/custom/run-spec',
      fetch: fetch as typeof globalThis.fetch
    });
    const registered = await transport.register(lease, 'short-token');
    expect(registered.runSpec.runId).toBe('run1');
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://control.example.test/internal/custom/run-spec');
    expect((fetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer short-token');
    expect(fetch.mock.calls[0]?.[1]?.body).not.toContain('short-token');
  });

  it('fails clearly on a missing control-plane endpoint', async () => {
    const transport = new FetchWorkerControlTransport({
      controlPlaneUrl: 'https://control.example.test',
      fetch: vi.fn(async () => new Response('not found', { status: 404 })) as typeof globalThis.fetch
    });
    await expect(transport.register(lease, 'token')).rejects.toThrow('failed (404): not found');
  });

  it('rejects malformed JSON responses at the schema boundary', async () => {
    const transport = new FetchWorkerControlTransport({
      controlPlaneUrl: 'https://control.example.test',
      fetch: vi.fn(async () => Response.json({ type: 'worker.registered' })) as typeof globalThis.fetch
    });
    await expect(transport.register(lease, 'token')).rejects.toThrow();
  });

  it('uses strict fenced Artifact reserve and commit endpoints', async () => {
    const now = '2026-08-12T00:00:00.000Z';
    const fetch = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).endsWith('/reserve')) return Response.json({
        protocolVersion: 2, messageId: 'reserved1', sentAt: now, type: 'artifact.reserved',
        idempotencyKey: 'reserve-key', runId: 'run1', generation: 1, artifactId: 'artifact1',
        alreadyCommitted: false,
        upload: { method: 'PUT', url: 'https://blob.example.test/upload', headers: [], expiresAt: '2099-01-01T00:00:00.000Z' }
      });
      return Response.json({
        protocolVersion: 2, messageId: 'committed1', sentAt: now, type: 'artifact.committed',
        idempotencyKey: 'commit-key', runId: 'run1', generation: 1,
        artifact: {
          id: 'artifact1', organizationId: 'org1', projectId: 'project1', taskId: 'task1', kind: 'document',
          displayName: 'report.md', status: 'ready', mimeType: 'text/markdown', sizeBytes: 8, sha256: 'a'.repeat(64),
          sourceIds: [], previewAvailable: true, readyAt: now, createdAt: now
        }
      });
    });
    const transport = new FetchWorkerControlTransport({ controlPlaneUrl: 'https://control.example.test', fetch: fetch as typeof globalThis.fetch });
    const reserved = await transport.reserveArtifact({ lease, runToken: 'token', artifact: {
      idempotencyKey: 'reserve-key', taskId: 'task1', kind: 'document', displayName: 'report.md', mimeType: 'text/markdown', sizeBytes: 8, sha256: 'a'.repeat(64), sourceIds: []
    } });
    expect(reserved).toMatchObject({ artifactId: 'artifact1', alreadyCommitted: false });
    const committed = await transport.commitArtifact({ lease, runToken: 'token', commit: {
      idempotencyKey: 'commit-key', artifactId: 'artifact1', sizeBytes: 8, sha256: 'a'.repeat(64)
    } });
    expect(committed).toMatchObject({ id: 'artifact1', runId: 'run1', status: 'ready' });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://control.example.test/internal/v2/workers/artifacts/reserve',
      'https://control.example.test/internal/v2/workers/artifacts/commit'
    ]);
  });
});
