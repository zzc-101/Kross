import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import {
  existsSync,
  readFileSync,
  statSync
} from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  clientCommandSchema,
  PROTOCOL_VERSION,
  type ClientCommand,
  type EventEnvelope
} from '@kross/protocol';
import { WebSocketServer, WebSocket } from 'ws';

import { readBearerToken, tokenMatches } from './auth';
import { GatewayService } from './gatewayService';

export interface GatewayHttpServerOptions {
  accessToken: string;
  host?: string;
  port?: number;
  staticDir?: string;
  allowedOrigins?: string[];
}

export class GatewayHttpServer {
  private readonly http: Server;
  private readonly ws = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has('kross.v1') ? 'kross.v1' : false
  });

  constructor(
    private readonly gateway: GatewayService,
    private readonly options: GatewayHttpServerOptions
  ) {
    this.http = createServer((request, response) => {
      this.route(request, response);
    });
    this.http.on('upgrade', (request, socket, head) => {
      if (!originAllowed(request, options.allowedOrigins ?? [])) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (
        !this.authorized(request.headers.authorization) &&
        !tokenMatches(readWebSocketToken(request.headers['sec-websocket-protocol']), options.accessToken)
      ) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.ws.handleUpgrade(request, socket, head, (client) => {
        this.ws.emit('connection', client);
      });
    });
    this.ws.on('connection', (client) => this.connect(client));
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
    for (const client of this.ws.clients) client.close(1001, 'server shutdown');
    await new Promise<void>((resolve) => this.ws.close(() => resolve()));
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
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      !(request.url ?? '').startsWith('/api/') &&
      this.serveStatic(
        request.url ?? '/',
        response,
        request.method === 'HEAD'
      )
    ) {
      return;
    }
    if (!this.authorized(request.headers.authorization)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
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

  private serveStatic(
    url: string,
    response: ServerResponse,
    headOnly = false
  ): boolean {
    if (!this.options.staticDir) return false;
    let requestPath: string;
    try {
      requestPath = decodeURIComponent(url.split('?')[0] ?? '/');
    } catch {
      return false;
    }
    const root = resolve(this.options.staticDir);
    const candidate = resolve(root, `.${requestPath}`);
    const safeCandidate =
      relative(root, candidate).startsWith('..') ? undefined : candidate;
    const file =
      safeCandidate &&
      existsSync(safeCandidate) &&
      statSync(safeCandidate).isFile()
        ? safeCandidate
        : join(root, 'index.html');
    if (!existsSync(file)) return false;
    response.writeHead(200, {
      'content-type': contentType(extname(file)),
      'cache-control':
        file.endsWith('index.html')
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
      'content-security-policy':
        "default-src 'self'; connect-src 'self' https: http: ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer'
    });
    response.end(headOnly ? undefined : readFileSync(file));
    return true;
  }

  private connect(client: WebSocket): void {
    const workspaceIds = new Set<string>();
    const sessionIds = new Set<string>();
    const awaitingSessionCreate = new Set<string>();
    const send = (event: EventEnvelope) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(event));
      }
    };
    const sendSubscribed = (event: EventEnvelope) => {
      if (event.workspaceId !== '$gateway' && !workspaceIds.has(event.workspaceId)) {
        return;
      }
      if (event.sessionId && !sessionIds.has(event.sessionId)) {
        if (
          event.event.type === 'session.snapshot' &&
          awaitingSessionCreate.has(event.workspaceId)
        ) {
          sessionIds.add(event.sessionId);
          awaitingSessionCreate.delete(event.workspaceId);
        } else {
          return;
        }
      }
      send(event);
    };
    const unsubscribe = this.gateway.subscribe(sendSubscribed);
    client.once('close', unsubscribe);
    client.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        send(invalidCommandEvent('INVALID_JSON', '消息不是合法 JSON'));
        return;
      }
      const parsed = clientCommandSchema.safeParse(raw);
      if (!parsed.success) {
        send(invalidCommandEvent('INVALID_COMMAND', parsed.error.message));
        return;
      }
      if ('workspaceId' in parsed.data) {
        workspaceIds.add(parsed.data.workspaceId);
      }
      if ('sessionId' in parsed.data) {
        sessionIds.add(parsed.data.sessionId);
      }
      if (parsed.data.type === 'session.create') {
        awaitingSessionCreate.add(parsed.data.workspaceId);
      }
      void this.gateway.handle(parsed.data, send);
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

function originAllowed(
  request: IncomingMessage,
  allowedOrigins: string[]
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.host === request.headers.host) return true;
    return allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

function contentType(extension: string): string {
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.webmanifest': 'application/manifest+json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon'
    }[extension] ?? 'application/octet-stream'
  );
}

function readWebSocketToken(header: string | undefined): string | undefined {
  const encoded = header
    ?.split(',')
    .map((value) => value.trim())
    .find((value) => value.startsWith('kross.token.'))
    ?.slice('kross.token.'.length);
  if (!encoded) return undefined;
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

function invalidCommandEvent(code: string, message: string): EventEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: '$gateway',
    seq: 0,
    timestamp: new Date().toISOString(),
    event: { type: 'request.error', code, message }
  };
}

export function commandWithVersion(
  command: Omit<ClientCommand, 'protocolVersion'>
): ClientCommand {
  return { ...command, protocolVersion: PROTOCOL_VERSION } as ClientCommand;
}
