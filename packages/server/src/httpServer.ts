import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  artifactCommittedMessageSchema,
  artifactReservedMessageSchema,
  internalWorkerMessageSchema,
    leaseRenewedMessageSchema,
  resourceIdSchema,
  workerEventAckMessageSchema,
  workerRegisteredMessageSchema
} from '@kross/protocol';

import type { ApiService } from './apiService';
import { ServerError } from './errors';
import type { WorkerControlService } from './workerControl';
import type { BlobStore, SignedBlobUrlProvider } from './blobStore';
import type { AdminService } from './adminService';
import type { Identity } from './identity';

const MAX_BODY_BYTES = 1_048_576;

export interface HttpServerOptions {
  readonly api: ApiService;
  readonly admin?: AdminService;
  readonly workerControl?: WorkerControlService;
  readonly blobStore?: BlobStore;
  readonly signedBlobUrls?: SignedBlobUrlProvider;
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
    const blobMatch = match(url.pathname, /^\/api\/v2\/blobs\/(upload|download)\/([^/]+)$/);
    if (blobMatch) {
      await handleSignedBlob(options, request, response, blobMatch[0]!, blobMatch[1]!);
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

    if (request.method === 'POST' && url.pathname === '/api/v2/admin/bootstrap') {
      if (!options.admin) throw new ServerError('admin_unavailable', 'Admin API is unavailable', 503);
      sendJson(response, 201, await options.admin.bootstrap(identity, await readJson(request))); return;
    }

    if (request.method === 'GET' && url.pathname === '/api/v2/me') {
      sendJson(response, 200, await options.api.me(identity)); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v2/organizations') {
      const me = await options.api.me(identity);
      sendJson(response, 200, { items: me.memberships }); return;
    }
    if (!organizationId) throw new ServerError('organization_required', 'x-kross-organization-id is required', 400);

    if (url.pathname.startsWith('/api/v2/admin/')) {
      await handleAdminRequest(options, request, response, url, identity, organizationId); return;
    }

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
    const projectSourcesMatch = match(url.pathname, /^\/api\/v2\/projects\/([^/]+)\/sources$/);
    if (request.method === 'GET' && projectSourcesMatch) {
      sendJson(response, 200, { items: await options.api.listSources(identity, organizationId, projectSourcesMatch[0]!) }); return;
    }
    const sourceCreateMatch = match(url.pathname, /^\/api\/v2\/projects\/([^/]+)\/sources\/(uploads|inline|external)$/);
    if (request.method === 'POST' && sourceCreateMatch) {
      const body = await readJson(request);
      const result = sourceCreateMatch[1] === 'uploads'
        ? await options.api.createSourceUpload(identity, organizationId, sourceCreateMatch[0]!, body)
        : sourceCreateMatch[1] === 'inline'
          ? await options.api.createInlineSource(identity, organizationId, sourceCreateMatch[0]!, body)
          : await options.api.createExternalSource(identity, organizationId, sourceCreateMatch[0]!, body);
      sendJson(response, 201, result); return;
    }
    const sourceCompleteMatch = match(url.pathname, /^\/api\/v2\/sources\/([^/]+)\/complete$/);
    if (request.method === 'POST' && sourceCompleteMatch) {
      sendJson(response, 200, await options.api.completeSource(identity, organizationId, sourceCompleteMatch[0]!, await readJson(request))); return;
    }
    const taskMatch = match(url.pathname, /^\/api\/v2\/tasks\/([^/]+)$/);
    if (request.method === 'GET' && taskMatch) {
      sendJson(response, 200, await options.api.getTask(identity, organizationId, taskMatch[0]!)); return;
    }
    const taskMessagesMatch = match(url.pathname, /^\/api\/v2\/tasks\/([^/]+)\/messages$/);
    if (taskMessagesMatch) {
      if (request.method === 'GET') { sendJson(response, 200, { items: await options.api.listTaskMessages(identity, organizationId, taskMessagesMatch[0]!) }); return; }
      if (request.method === 'POST') { sendJson(response, 201, await options.api.appendTaskMessage(identity, organizationId, taskMessagesMatch[0]!, await readJson(request), headers['idempotency-key'])); return; }
    }
    const taskRunsMatch = match(url.pathname, /^\/api\/v2\/tasks\/([^/]+)\/runs$/);
    if (request.method === 'POST' && taskRunsMatch) {
      sendJson(response, 201, await options.api.createRun(identity, organizationId, taskRunsMatch[0]!, await readJson(request), headers['idempotency-key'])); return;
    }
    const taskArtifactsMatch = match(url.pathname, /^\/api\/v2\/tasks\/([^/]+)\/artifacts$/);
    if (request.method === 'GET' && taskArtifactsMatch) {
      sendJson(response, 200, { items: await options.api.listArtifacts(identity, organizationId, taskArtifactsMatch[0]!) }); return;
    }
    const artifactMatch = match(url.pathname, /^\/api\/v2\/artifacts\/([^/]+)$/);
    if (request.method === 'GET' && artifactMatch) {
      sendJson(response, 200, await options.api.getArtifact(identity, organizationId, artifactMatch[0]!)); return;
    }
    const artifactContentMatch = match(url.pathname, /^\/api\/v2\/artifacts\/([^/]+)\/content$/);
    if (request.method === 'GET' && artifactContentMatch) {
      response.writeHead(302, { location: await options.api.artifactContentUrl(identity, organizationId, artifactContentMatch[0]!), 'cache-control': 'private, no-store' });
      response.end(); return;
    }
    if (url.pathname === '/api/v2/connectors') {
      if (request.method === 'GET') {
        sendJson(response, 200, { items: await options.api.listConnectors(identity, organizationId) }); return;
      }
      if (request.method === 'POST') {
        sendJson(response, 201, await options.api.installConnector(identity, organizationId, await readJson(request))); return;
      }
    }
    const connectorDeleteMatch = match(url.pathname, /^\/api\/v2\/connector-installations\/([^/]+)$/);
    if (request.method === 'DELETE' && connectorDeleteMatch) {
      sendJson(response, 200, await options.api.revokeConnector(identity, organizationId, connectorDeleteMatch[0]!)); return;
    }
    if (url.pathname === '/api/v2/schedules') {
      if (request.method === 'GET') {
        sendJson(response, 200, { items: await options.api.listSchedules(identity, organizationId) }); return;
      }
      if (request.method === 'POST') {
        sendJson(response, 201, await options.api.createSchedule(identity, organizationId, await readJson(request))); return;
      }
    }
    const scheduleMatch = match(url.pathname, /^\/api\/v2\/schedules\/([^/]+)$/);
    if (request.method === 'PATCH' && scheduleMatch) {
      sendJson(response, 200, await options.api.updateSchedule(identity, organizationId, scheduleMatch[0]!, await readJson(request))); return;
    }
    const runMatch = match(url.pathname, /^\/api\/v2\/runs\/([^/]+)$/);
    if (request.method === 'GET' && runMatch) {
      sendJson(response, 200, await options.api.getRun(identity, organizationId, runMatch[0]!)); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v2/approvals') {
      sendJson(response, 200, { items: await options.api.listPendingApprovals(identity, organizationId) }); return;
    }
    const approvalDecisionMatch = match(url.pathname, /^\/api\/v2\/approvals\/([^/]+)\/decision$/);
    if (request.method === 'POST' && approvalDecisionMatch) {
      sendJson(response, 200, await options.api.decideApproval(identity, organizationId, approvalDecisionMatch[0]!, await readJson(request), headers['idempotency-key'])); return;
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

async function handleAdminRequest(
  options: HttpServerOptions, request: IncomingMessage, response: ServerResponse,
  url: URL, identity: Identity, organizationId: string
): Promise<void> {
  const admin = options.admin;
  if (!admin) throw new ServerError('admin_unavailable', 'Admin API is unavailable', 503);
  const query = Object.fromEntries(url.searchParams.entries());
  if (request.method === 'GET' && url.pathname === '/api/v2/admin/dashboard') { sendJson(response, 200, await admin.dashboard(identity, organizationId)); return; }
  if (url.pathname === '/api/v2/admin/members') {
    if (request.method === 'GET') { sendJson(response, 200, await admin.listMembers(identity, organizationId, query)); return; }
    if (request.method === 'POST') { sendJson(response, 201, await admin.inviteMember(identity, organizationId, await readJson(request))); return; }
  }
  const member = match(url.pathname, /^\/api\/v2\/admin\/members\/([^/]+)$/);
  if (member && request.method === 'PATCH') { sendJson(response, 200, await admin.updateMember(identity, organizationId, member[0]!, await readJson(request))); return; }
  if (member && request.method === 'DELETE') { sendJson(response, 200, await admin.removeMember(identity, organizationId, member[0]!)); return; }
  if (url.pathname === '/api/v2/admin/approval-policy') {
    if (request.method === 'GET') { sendJson(response, 200, await admin.getPolicy(identity, organizationId)); return; }
    if (request.method === 'PATCH') { sendJson(response, 200, await admin.updatePolicy(identity, organizationId, await readJson(request))); return; }
  }
  if (request.method === 'GET' && url.pathname === '/api/v2/admin/connectors') { sendJson(response, 200, { items: await options.api.listConnectors(identity, organizationId) }); return; }
  if (request.method === 'GET' && url.pathname === '/api/v2/admin/audit-logs') { sendJson(response, 200, await admin.listAuditLogs(identity, organizationId, query)); return; }
  if (url.pathname === '/api/v2/admin/credentials') {
    if (request.method === 'GET') { sendJson(response, 200, await admin.listCredentials(identity, organizationId, query)); return; }
    if (request.method === 'POST') { sendJson(response, 201, await admin.createCredential(identity, organizationId, await readJson(request))); return; }
  }
  const credential = match(url.pathname, /^\/api\/v2\/admin\/credentials\/([^/]+)$/);
  if (credential && request.method === 'PATCH') { sendJson(response, 200, await admin.updateCredential(identity, organizationId, credential[0]!, await readJson(request))); return; }
  if (credential && request.method === 'DELETE') { sendJson(response, 200, await admin.deleteCredential(identity, organizationId, credential[0]!)); return; }
  if (url.pathname === '/api/v2/admin/models') {
    if (request.method === 'GET') { sendJson(response, 200, await admin.listModels(identity, organizationId, query)); return; }
    if (request.method === 'POST') { sendJson(response, 201, await admin.createModel(identity, organizationId, await readJson(request))); return; }
  }
  const model = match(url.pathname, /^\/api\/v2\/admin\/models\/([^/]+)$/);
  if (model && request.method === 'PATCH') { sendJson(response, 200, await admin.updateModel(identity, organizationId, model[0]!, await readJson(request))); return; }
  if (model && request.method === 'DELETE') { sendJson(response, 200, await admin.deleteModel(identity, organizationId, model[0]!)); return; }
  throw new ServerError('not_found', 'Route not found', 404);
}

async function handleWorkerRequest(
  options: HttpServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  path: string
): Promise<void> {
  const service = options.workerControl;
  if (!service) throw new ServerError('worker_control_unavailable', 'Worker control is unavailable', 503);
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new ServerError('worker_unauthenticated', 'Run-scoped Bearer token is required', 401);
  }
  const token = authorization.slice(7);
  if (path === '/internal/v2/workers/approval-decision' && request.method === 'GET') {
    const decision = await service.nextApprovalDecision(token);
    if (!decision) { response.writeHead(204); response.end(); return; }
    sendJson(response, 200, decision); return;
  }
  if (path === '/internal/v2/workers/checkpoints' && request.method === 'PUT') {
    const url = new URL(request.url ?? '/', 'http://server.local');
    const sha256 = url.searchParams.get('sha256') ?? '';
    const sizeBytes = Number(url.searchParams.get('sizeBytes'));
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new ServerError('invalid_checkpoint_metadata', 'Invalid checkpoint metadata', 400);
    }
    sendJson(response, 201, await service.putCheckpoint(token, { sha256, sizeBytes }, request)); return;
  }
  if (path === '/internal/v2/workers/checkpoints' && request.method === 'GET') {
    const url = new URL(request.url ?? '/', 'http://server.local');
    const key = url.searchParams.get('key');
    if (!key) throw new ServerError('checkpoint_key_required', 'Checkpoint key is required', 400);
    const content = await service.getCheckpoint(token, key);
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    for await (const chunk of content) response.write(chunk);
    response.end(); return;
  }
  if (request.method !== 'POST') throw new ServerError('not_found', 'Route not found', 404);
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
  if (path === '/internal/v2/workers/artifacts/reserve' && message.type === 'artifact.reserve') {
    sendJson(response, 200, artifactReservedMessageSchema.parse(await service.reserveArtifact(token, message)));
    return;
  }
  if (path === '/internal/v2/workers/artifacts/commit' && message.type === 'artifact.commit') {
    sendJson(response, 200, artifactCommittedMessageSchema.parse(await service.commitArtifact(token, message)));
    return;
  }
  throw new ServerError('worker_message_route_mismatch', 'Worker message type does not match route', 400);
}

async function handleSignedBlob(
  options: HttpServerOptions, request: IncomingMessage, response: ServerResponse,
  action: string, token: string
): Promise<void> {
  if (!options.blobStore || !options.signedBlobUrls) {
    throw new ServerError('blob_service_unavailable', 'Blob service is unavailable', 503);
  }
  if (action === 'upload') {
    if (request.method !== 'PUT') throw new ServerError('method_not_allowed', 'Signed upload requires PUT', 405);
    const claim = options.signedBlobUrls.verify(token, 'upload');
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (claim.mimeType !== undefined && contentType !== claim.mimeType) {
      throw new ServerError('blob_mime_mismatch', 'Uploaded MIME type does not match', 422);
    }
    const stored = await options.blobStore.put(claim.blobKey, request, {
      maxBytes: claim.maxBytes ?? MAX_BODY_BYTES,
      ...(claim.sizeBytes === undefined ? {} : { expectedSizeBytes: claim.sizeBytes }),
      ...(claim.sha256 === undefined ? {} : { expectedSha256: claim.sha256 })
    });
    sendJson(response, 201, stored);
    return;
  }
  if (action === 'download') {
    if (request.method !== 'GET') throw new ServerError('method_not_allowed', 'Signed download requires GET', 405);
    const claim = options.signedBlobUrls.verify(token, 'download');
    const metadata = await options.blobStore.stat(claim.blobKey);
    if (!metadata) throw new ServerError('blob_not_found', 'Blob not found', 404);
    response.writeHead(200, {
      'content-type': claim.mimeType ?? 'application/octet-stream',
      'content-length': String(metadata.sizeBytes), 'etag': `"${metadata.sha256}"`,
      'cache-control': 'private, no-store'
    });
    for await (const chunk of options.blobStore.read(claim.blobKey)) response.write(chunk);
    response.end();
    return;
  }
  throw new ServerError('not_found', 'Route not found', 404);
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
