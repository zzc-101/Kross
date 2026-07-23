import { createServer, type Server } from 'node:http';

import {
  clientCommandSchema,
  type EventEnvelope
} from '@kross/protocol';
import { WebSocketServer, WebSocket } from 'ws';

import { WorkerService } from './workerService';

export interface WorkerWsServerOptions {
  host?: string;
  port?: number;
  internalToken: string;
}

export class WorkerWsServer {
  private readonly http: Server;
  private readonly ws: WebSocketServer;

  constructor(
    private readonly service: WorkerService,
    private readonly options: WorkerWsServerOptions
  ) {
    this.http = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'kross-worker' }));
    });
    this.ws = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (request, socket, head) => {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (token !== options.internalToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.ws.handleUpgrade(request, socket, head, (client) => {
        this.ws.emit('connection', client, request);
      });
    });
    this.ws.on('connection', (client) => this.connect(client));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(
        this.options.port ?? 8788,
        this.options.host ?? '0.0.0.0',
        resolve
      );
    });
  }

  async close(): Promise<void> {
    for (const client of this.ws.clients) client.close(1001, 'server shutdown');
    await new Promise<void>((resolve) => this.ws.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      this.http.close((error) => (error ? reject(error) : resolve()))
    );
    await this.service.close();
  }

  private connect(client: WebSocket): void {
    const sink = (event: EventEnvelope) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(event));
      }
    };
    const unsubscribe = this.service.subscribe(sink);
    client.once('close', unsubscribe);
    client.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        client.send(JSON.stringify({ error: 'INVALID_JSON' }));
        return;
      }
      const parsed = clientCommandSchema.safeParse(raw);
      if (!parsed.success) {
        client.send(
          JSON.stringify({
            error: 'INVALID_COMMAND',
            details: parsed.error.flatten()
          })
        );
        return;
      }
      void this.service.handle(parsed.data, sink);
    });
  }
}
