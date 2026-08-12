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
});
