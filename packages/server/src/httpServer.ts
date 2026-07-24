import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  clientCommandSchema,
  PROTOCOL_VERSION,
  type ClientCommand,
  type EventEnvelope
} from '@kross/protocol';

import { readBearerToken, tokenMatches } from './auth';
import { GatewayService } from './gatewayService';

export interface GatewayHttpServerOptions {
  accessToken: string;
  host?: string;
  port?: number;
  sseHeartbeatMs?: number;
}

export class GatewayHttpServer {
  private readonly http: Server;
  private readonly eventStreams = new Set<ServerResponse>();

  constructor(
    private readonly gateway: GatewayService,
    private readonly options: GatewayHttpServerOptions
  ) {
    this.http = createServer((request, response) => {
      this.route(request, response);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(
        this.options.port ?? 8787,
        this.options.host ?? '0.0.0.0',
        resolve
      );
    });
  }

  address(): AddressInfo | undefined {
    const address = this.http.address();
    return address && typeof address !== 'string' ? address : undefined;
  }

  async close(): Promise<void> {
    for (const stream of this.eventStreams) stream.end();
    this.eventStreams.clear();
    await new Promise<void>((resolve, reject) =>
      this.http.close((error) => (error ? reject(error) : resolve()))
    );
    await this.gateway.close();
  }

  private route(
    request: IncomingMessage,
    response: ServerResponse
  ): void {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!this.authorized(request.headers.authorization)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/events') {
      this.connectEventStream(response);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/commands') {
      void this.receiveCommand(request, response);
      return;
    }
    if (request.method === 'GET' && request.url === '/api/workspaces') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(this.gateway.listWorkspaces()));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/config') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ vapidPublicKey: this.gateway.getPushPublicKey() })
      );
      return;
    }
    if (request.method === 'GET' && request.url === '/api/setup') {
      void this.gateway
        .getSetupStatus(isSecureRequest(request))
        .then((status) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(status));
        })
        .catch((error) => {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            error: error instanceof Error ? error.message : String(error)
          }));
        });
      return;
    }
    if (request.method === 'PUT' && request.url === '/api/provider') {
      if (!isSecureRequest(request)) {
        response.writeHead(426, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          error: 'Provider 密钥只能通过 HTTPS 或 localhost 保存'
        }));
        return;
      }
      void readJsonBody(request)
        .then((body) => {
          const value =
            body && typeof body === 'object'
              ? body as Record<string, unknown>
              : {};
          return this.gateway.updateProvider(
            value.provider,
            value.restartWorkers === true
          );
        })
        .then((result) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(result));
        })
        .catch((error) => {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            error: error instanceof Error ? error.message : String(error)
          }));
        });
      return;
    }
    const parsedUrl = new URL(request.url ?? '/', 'http://localhost');
    const sessionsMatch = parsedUrl.pathname.match(
      /^\/api\/workspaces\/([^/]+)\/sessions$/
    );
    if (request.method === 'GET' && sessionsMatch?.[1]) {
      const limit = Number(parsedUrl.searchParams.get('limit') ?? 20);
      void this.gateway
        .listSessions(decodeURIComponent(sessionsMatch[1]), limit)
        .then((sessions) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(sessions));
        })
        .catch((error) => {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error)
            })
          );
        });
      return;
    }
    const inspectionMatch = parsedUrl.pathname.match(
      /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/(trace|diff)$/
    );
    if (
      request.method === 'GET' &&
      inspectionMatch?.[1] &&
      inspectionMatch[2] &&
      (inspectionMatch[3] === 'trace' || inspectionMatch[3] === 'diff')
    ) {
      void this.gateway
        .inspectSession(
          decodeURIComponent(inspectionMatch[1]),
          decodeURIComponent(inspectionMatch[2]),
          inspectionMatch[3],
          parsedUrl.searchParams.get('argument') ?? undefined
        )
        .then((content) => {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          response.end(content);
        })
        .catch((error) => {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error)
            })
          );
        });
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'NOT_FOUND' }));
  }

  private connectEventStream(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
      connection: 'keep-alive'
    });
    response.write('retry: 3000\n\n');
    this.eventStreams.add(response);
    const send = (event: EventEnvelope) => {
      if (!response.destroyed) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };
    const unsubscribe = this.gateway.subscribe(send);
    send(this.gateway.initialEvent());
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': ping\n\n');
    }, this.options.sseHeartbeatMs ?? 25_000);
    heartbeat.unref();
    response.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      this.eventStreams.delete(response);
    });
  }

  private async receiveCommand(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    const parsed = clientCommandSchema.safeParse(body);
    if (!parsed.success) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: 'INVALID_COMMAND',
        details: parsed.error.issues
      }));
      return;
    }
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      accepted: true,
      requestId: parsed.data.requestId
    }));
    void this.gateway.handle(parsed.data).catch((error) => {
      this.gateway.broadcast(commandFailureEvent(
        parsed.data.requestId,
        'COMMAND_FAILED',
        error instanceof Error ? error.message : String(error)
      ));
    });
  }

  private authorized(authorization: string | undefined): boolean {
    return tokenMatches(readBearerToken(authorization), this.options.accessToken);
  }
}

async function readJsonBody(
  request: IncomingMessage,
  limitBytes = 64 * 1024
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) throw new Error('请求内容过大');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求内容不是合法 JSON');
  }
}

function isSecureRequest(request: IncomingMessage): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const hostname = request.headers.host?.split(':')[0]?.toLowerCase();
  return (
    protocol === 'https' ||
    Boolean((request.socket as { encrypted?: boolean }).encrypted) ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}


function commandFailureEvent(
  requestId: string,
  code: string,
  message: string
): EventEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    source: 'gateway',
    workspaceId: '$gateway',
    correlationId: requestId,
    seq: 0,
    timestamp: new Date().toISOString(),
    event: { type: 'request.error', requestId, code, message }
  };
}

export function commandWithVersion(
  command: Omit<ClientCommand, 'protocolVersion'>
): ClientCommand {
  return { ...command, protocolVersion: PROTOCOL_VERSION } as ClientCommand;
}
