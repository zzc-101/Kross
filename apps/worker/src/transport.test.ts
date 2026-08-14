import { describe, expect, it, vi } from 'vitest';
import { FetchAgentControlTransport } from './transport';

describe('FetchAgentControlTransport', () => {
  it('registers with the agent token and no durable credential', async () => {
    const fetch = vi.fn(async () => json({ heartbeatIntervalMs: 10_000, idleMs: 900_000 }));
    const transport = new FetchAgentControlTransport({
      agentId: 'agent1',
      agentToken: 'short-token',
      controlPlaneUrl: 'https://control.example.test',
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    await expect(transport.register()).resolves.toEqual({ heartbeatIntervalMs: 10_000, idleMs: 900_000 });
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/internal/v2/agents/register');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer short-token');
    expect(JSON.parse(String(init.body))).toMatchObject({ type: 'agent.register', agentId: 'agent1' });
  });

  it('treats an empty job poll as idle', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = new FetchAgentControlTransport({
      agentId: 'agent1',
      agentToken: 'short-token',
      controlPlaneUrl: 'https://control.example.test',
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    await expect(transport.claimJob()).resolves.toBeUndefined();
  });

  it('rejects a missing agent token', () => {
    expect(() => new FetchAgentControlTransport({
      agentId: 'agent1',
      agentToken: '  ',
      controlPlaneUrl: 'https://control.example.test'
    })).toThrow('Agent token is required');
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
