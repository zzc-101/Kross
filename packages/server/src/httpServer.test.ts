import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eventEnvelopeSchema, PROTOCOL_VERSION } from '@kross/protocol';
import WebSocket from 'ws';
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
  it('serves the PWA publicly and authenticates API and WebSocket traffic', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-http-'));
    const staticDir = join(root, 'web');
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, 'index.html'), '<h1>Kross</h1>');
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
      staticDir
    });
    await server.listen();
    const port = server.address()?.port;
    if (!port) throw new Error('missing port');

    const shellResponse = await fetch(`http://127.0.0.1:${port}/`);
    expect(await shellResponse.text()).toContain('Kross');
    expect(shellResponse.headers.get('content-security-policy')).toContain(
      "default-src 'self'"
    );
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' })
      ).status
    ).toBe(200);
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

    const rejectedSocket = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      [
        'kross.v1',
        `kross.token.${Buffer.from('secret-token').toString('base64url')}`
      ],
      { origin: 'https://evil.example' }
    );
    const rejectedStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        rejectedSocket.once('unexpected-response', (_request, response) =>
          resolve(response.statusCode)
        );
        rejectedSocket.once('error', reject);
      }
    );
    expect(rejectedStatus).toBe(403);

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      ['kross.v1', `kross.token.${Buffer.from('secret-token').toString('base64url')}`]
    );
    const eventPromise = new Promise<unknown>((resolve, reject) => {
      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            requestId: 'list',
            type: 'workspace.list'
          })
        );
      });
      socket.once('message', (data) => resolve(JSON.parse(data.toString())));
      socket.once('error', reject);
    });
    const event = eventEnvelopeSchema.parse(await eventPromise);
    expect(event.event.type).toBe('workspace.list');
    socket.close();
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await server.close();
  });
});
