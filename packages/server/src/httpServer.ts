import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  internalWorkerMessageSchema,
  leaseRenewedMessageSchema,
  resourceIdSchema,
  workerEventAckMessageSchema,
  workerRegisteredMessageSchema
} from '@kross/protocol';

import type { ApiService } from './apiService';
import { ServerError } from './errors';
import type { WorkerControlService } from './workerControl';

const MAX_BODY_BYTES = 1_048_576;

export interface HttpServerOptions {
  readonly api: ApiService;
  readonly workerControl?: WorkerControlService;
  readonly exposeErrorDetails?: boolean;
}

export function createApiHttpServer(options: HttpServerOptions): Server {
  return createServer((request, response) => {
    void handleRequest(options, request, response);
  });
}

async function handleRequest(
  options: HttpServerOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://server.local');
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', service: 'kross-control-plane' });
      return;
    }
    if (url.pathname.startsWith('/internal/v2/workers/')) {
      await handleWorkerRequest(options, request, response, url.pathname);
      return;
    }
    if (!url.pathname.startsWith('/api/v2/')) throw new ServerError('not_found', 'Route not found', 404);
    const headers = normalizeHeaders(request);
    const identity = await options.api.authenticate(headers);
    const organizationId = headers['x-kross-organization-id'];

    if (request.method === 'GET' && url.pathname === '/api/v2/me') {
      sendJson(response, 200, await options.api.me(identity)); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v2/organizations') {
      const me = await options.api.me(identity);
      sendJson(response, 200, { items: me.memberships }); return;
    }
    if (!organizationId) throw new ServerError('organization_required', 'x-kross-organization-id is required', 400);

    const organizationMatch = match(url.pathname, /^\/api\/v2\/organizations\/([^/]+)$/);
    if (request.method === 'GET' && organizationMatch) {
      sendJson(response, 200, await options.api.organization(identity, organizationMatch[0]!)); return;
    }
    if (url.pathname === '/api/v2/projects') {
      if (request.method === 'GET') {
        sendJson(response, 200, { items: await options.api.listProjects(identity, organizationId) }); return;
      }
      if (request.method === 'POST') {
        sendJson(response, 201, await options.api.createProject(identity, organizationId, await readJson(request))); return;
      }
    }
    const projectMatch = match(url.pathname, /^\/api\/v2\/projects\/([^/]+)$/);
    if (request.method === 'GET' && projectMatch) {
      sendJson(response, 200, await options.api.getProject(identity, organizationId, projectMatch[0]!)); return;
    }
    const projectTasksMatch = match(url.pathname, /^\/api\/v2\/projects\/([^/]+)\/tasks$/);
    if (projectTasksMatch) {
      if (request.method === 'GET') {
        sendJson(response, 200, { items: await options.api.listTasks(identity, organizationId, projectTasksMatch[0]!) }); return;
      }
      if (request.method === 'POST') {
        const body = { ...(await readJson(request)), projectId: projectTasksMatch[0] };
        sendJson(response, 201, await options.api.createTask(identity, organizationId, body, headers['idempotency-key'])); return;
      }
    }
    const taskMatch = match(url.pathname, /^\/api\/v2\/tasks\/([^/]+)$/);
    if (request.method === 'GET' && taskMatch) {
      sendJson(response, 200, await options.api.getTask(identity, organizationId, taskMatch[0]!)); return;
    }
    const taskRunsMatch = match(url.pathname, /^\/api\/v2\/tasks\/([^/]+)\/runs$/);
    if (request.method === 'POST' && taskRunsMatch) {
      sendJson(response, 201, await options.api.createRun(identity, organizationId, taskRunsMatch[0]!, await readJson(request), headers['idempotency-key'])); return;
    }
    const runMatch = match(url.pathname, /^\/api\/v2\/runs\/([^/]+)$/);
    if (request.method === 'GET' && runMatch) {
      sendJson(response, 200, await options.api.getRun(identity, organizationId, runMatch[0]!)); return;
    }
    const cancelMatch = match(url.pathname, /^\/api\/v2\/runs\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      sendJson(response, 202, await options.api.cancelRun(identity, organizationId, cancelMatch[0]!)); return;
    }
    const runEventsMatch = match(url.pathname, /^\/api\/v2\/runs\/([^/]+)\/events$/);
    if (request.method === 'GET' && (runEventsMatch || url.pathname === '/api/v2/events')) {
      const filters = {
        projectId: url.searchParams.get('project') ?? undefined,
        taskId: url.searchParams.get('task') ?? undefined,
        runId: runEventsMatch?.[0] ?? url.searchParams.get('run') ?? undefined
      };
      for (const id of Object.values(filters)) {
        if (id !== undefined && !resourceIdSchema.safeParse(id).success) throw new ServerError('invalid_filter', 'Invalid event filter', 400);
      }
      const chunks = await options.api.replayEvents(identity, organizationId, headers['last-event-id'], filters);
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      for (const chunk of chunks) response.write(chunk);
      response.write(': replay-complete\n\n');
      response.end();
      return;
    }
    throw new ServerError('not_found', 'Route not found', 404);
  } catch (error) {
    sendError(response, error, options.exposeErrorDetails ?? false);
  }
}

async function handleWorkerRequest(
  options: HttpServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  path: string
): Promise<void> {
  if (request.method !== 'POST') throw new ServerError('not_found', 'Route not found', 404);
  const service = options.workerControl;
  if (!service) throw new ServerError('worker_control_unavailable', 'Worker control is unavailable', 503);
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new ServerError('worker_unauthenticated', 'Run-scoped Bearer token is required', 401);
  }
  const token = authorization.slice(7);
  const parsed = internalWorkerMessageSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    throw new ServerError('invalid_worker_message', 'Invalid Protocol v2 Worker message', 400, {
      issues: parsed.error.issues
    });
  }
  const message = parsed.data;
  if (path === '/internal/v2/workers/register' && message.type === 'worker.register') {
    sendJson(response, 200, workerRegisteredMessageSchema.parse(await service.register(token, message)));
    return;
  }
  if (path === '/internal/v2/workers/events' && message.type === 'worker.event') {
    sendJson(response, 200, workerEventAckMessageSchema.parse(await service.appendEvent(token, message.envelope)));
    return;
  }
  if (path === '/internal/v2/workers/heartbeat' && message.type === 'worker.heartbeat') {
    sendJson(response, 200, leaseRenewedMessageSchema.parse(await service.heartbeat(token, message)));
    return;
  }
  if (path === '/internal/v2/workers/release' && message.type === 'lease.release') {
    await service.release(token, message);
    response.writeHead(204);
    response.end();
    return;
  }
  throw new ServerError('worker_message_route_mismatch', 'Worker message type does not match route', 400);
}

function normalizeHeaders(request: IncomingMessage): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    normalized[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new ServerError('body_too_large', 'Request body exceeds 1 MiB', 413);
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ServerError('invalid_json', 'Request body must be a JSON object', 400);
  }
}

function match(path: string, expression: RegExp): RegExpMatchArray | undefined {
  const result = path.match(expression);
  if (!result) return undefined;
  try {
    result[1] = decodeURIComponent(result[1]!);
    return result.slice(1) as unknown as RegExpMatchArray;
  } catch {
    throw new ServerError('invalid_path', 'Invalid URL path encoding', 400);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: unknown, exposeDetails: boolean): void {
  const known = error instanceof ServerError;
  const status = known ? error.statusCode : 500;
  const message = known ? error.message : 'Internal server error';
  const body: Record<string, unknown> = { error: { code: known ? error.code : 'internal_error', message } };
  if (exposeDetails && known && error.details) body.details = error.details;
  if (!response.headersSent) sendJson(response, status, body);
  else response.destroy();
}
