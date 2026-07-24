import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eventEnvelopeSchema, PROTOCOL_VERSION } from '@kross/protocol';
import { describe, expect, it } from 'vitest';

import type { ContainerOrchestrator } from './containerOrchestrator';
import { GatewayService } from './gatewayService';
import { GatewayHttpServer } from './httpServer';
import { RuntimeConfigStore } from './runtimeConfig';
import { WorkspaceRegistry } from './workspaceRegistry';

const unusedOrchestrator: ContainerOrchestrator = {
  async create() {
    throw new Error('unused');
  },
  async start() {},
  async stop() {},
  async remove() {},
  async workerUrl() {
    return 'ws://unused';
  },
  async inspect() {
    return { running: false };
  }
};

describe('GatewayHttpServer', () => {
  it('exposes authenticated command and SSE APIs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-http-'));
    const registry = new WorkspaceRegistry(join(root, 'workspaces.json'));
    const runtimeConfig = new RuntimeConfigStore(
      join(root, 'provider.json'),
      {}
    );
    const gateway = new GatewayService(
      registry,
      unusedOrchestrator,
      undefined,
      undefined,
      { runtimeConfig }
    );
    const server = new GatewayHttpServer(gateway, {
      accessToken: 'secret-token',
      host: '127.0.0.1',
      port: 0,
      sseHeartbeatMs: 10
    });
    await server.listen();
    const port = server.address()?.port;
    if (!port) throw new Error('missing port');

    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/workspaces`)).status).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
          headers: { authorization: 'Bearer secret-token' }
        })
      ).status
    ).toBe(200);
    const setup = await fetch(`http://127.0.0.1:${port}/api/setup`, {
      headers: { authorization: 'Bearer secret-token' }
    });
    expect(setup.status).toBe(200);
    expect((await setup.json()).provider.hasApiKey).toBe(false);
    const provider = await fetch(
      `http://127.0.0.1:${port}/api/provider`,
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          provider: {
            provider: 'openai',
            model: 'gpt-test',
            apiKey: 'provider-secret'
          },
          restartWorkers: false
        })
      }
    );
    expect(provider.status).toBe(200);
    expect(JSON.stringify(await provider.json())).not.toContain(
      'provider-secret'
    );

    expect(
      (await fetch(`http://127.0.0.1:${port}/api/events`)).status
    ).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/commands`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer secret-token',
            'content-type': 'application/json'
          },
          body: JSON.stringify({ type: 'workspace.list' })
        })
      ).status
    ).toBe(400);

    const streamController = new AbortController();
    const streamResponse = await fetch(
      `http://127.0.0.1:${port}/api/events`,
      {
        headers: { authorization: 'Bearer secret-token' },
        signal: streamController.signal
      }
    );
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toContain(
      'text/event-stream'
    );
    expect(streamResponse.headers.get('x-accel-buffering')).toBe('no');
    if (!streamResponse.body) throw new Error('missing SSE body');
    const frames = sseFrames(streamResponse.body);
    const initial = await nextDataEnvelope(frames);
    expect(initial.event.type).toBe('workspace.list');
    expect(initial.correlationId).toBeUndefined();

    const commandResponse = await fetch(
      `http://127.0.0.1:${port}/api/commands`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          requestId: 'list-command',
          type: 'workspace.list'
        })
      }
    );
    expect(commandResponse.status).toBe(202);
    expect(await commandResponse.json()).toEqual({
      accepted: true,
      requestId: 'list-command'
    });
    const correlated = await nextDataEnvelope(frames);
    expect(correlated.correlationId).toBe('list-command');
    expect(correlated.event.type).toBe('workspace.list');
    expect(await nextCommentFrame(frames)).toBe(': ping');

    streamController.abort();
    await server.close();
  });

  it('allows any origin by default and restricts when configured', async () => {
    const open = await startServer({ accessToken: 'secret-token' });
    const preflight = await fetch(`${open.url}/api/commands`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://web.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type'
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
    const unauthorized = await fetch(`${open.url}/api/workspaces`, {
      headers: { origin: 'https://web.example' }
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('access-control-allow-origin')).toBe('*');
    await open.server.close();

    const restricted = await startServer({
      accessToken: 'secret-token',
      allowedOrigins: ['https://app.example']
    });
    const allowed = await fetch(`${restricted.url}/api/workspaces`, {
      headers: {
        origin: 'https://app.example',
        authorization: 'Bearer secret-token'
      }
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      'https://app.example'
    );
    expect(allowed.headers.get('vary')).toBe('origin');
    const blocked = await fetch(`${restricted.url}/api/workspaces`, {
      headers: {
        origin: 'https://evil.example',
        authorization: 'Bearer secret-token'
      }
    });
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
    await restricted.server.close();
  });
});

async function startServer(options: {
  accessToken: string;
  allowedOrigins?: string[];
}): Promise<{ server: GatewayHttpServer; url: string }> {
  const root = mkdtempSync(join(tmpdir(), 'kross-http-'));
  const gateway = new GatewayService(
    new WorkspaceRegistry(join(root, 'workspaces.json')),
    unusedOrchestrator,
    undefined,
    undefined,
    { runtimeConfig: new RuntimeConfigStore(join(root, 'provider.json'), {}) }
  );
  const server = new GatewayHttpServer(gateway, {
    ...options,
    host: '127.0.0.1',
    port: 0
  });
  await server.listen();
  const port = server.address()?.port;
  if (!port) throw new Error('missing port');
  return { server, url: `http://127.0.0.1:${port}` };
}

async function* sseFrames(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        yield buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function nextDataEnvelope(
  frames: AsyncGenerator<string>
) {
  while (true) {
    const frame = await frames.next();
    if (frame.done) throw new Error('SSE ended before data');
    const line = frame.value
      .split('\n')
      .find((candidate) => candidate.startsWith('data: '));
    if (line) return eventEnvelopeSchema.parse(JSON.parse(line.slice(6)));
  }
}

async function nextCommentFrame(
  frames: AsyncGenerator<string>
): Promise<string> {
  while (true) {
    const frame = await frames.next();
    if (frame.done) throw new Error('SSE ended before heartbeat');
    if (frame.value.startsWith(':')) return frame.value;
  }
}
