import { once } from 'node:events';

import { PROTOCOL_VERSION } from '@kross/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';

import { WorkerClient } from './workerClient';

describe('WorkerClient', () => {
  it('reconnects after a broken worker socket and resumes known sessions', async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('unexpected pipe address');
    }
    const connections: WebSocket[] = [];
    const commands: Array<Record<string, unknown>> = [];
    server.on('connection', (socket) => {
      connections.push(socket);
      socket.on('message', (data) => {
        commands.push(JSON.parse(data.toString()));
      });
    });
    const client = new WorkerClient(
      `ws://127.0.0.1:${address.port}`,
      'token',
      'w1',
      { reconnectBaseMs: 1, heartbeatMs: 1_000 }
    );

    await client.send({
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'input-1',
      type: 'session.input',
      workspaceId: 'w1',
      sessionId: 's1',
      input: 'hello',
      mode: 'auto'
    });
    await vi.waitFor(() =>
      expect(commands.some((command) => command.requestId === 'input-1')).toBe(true)
    );
    connections[0]!.terminate();

    await vi.waitFor(() => expect(connections.length).toBeGreaterThan(1));
    await vi.waitFor(() =>
      expect(
        commands.some(
          (command) =>
            command.type === 'session.resume' &&
            command.workspaceId === 'w1' &&
            command.sessionId === 's1'
        )
      ).toBe(true)
    );

    client.close();
    for (const socket of connections) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
