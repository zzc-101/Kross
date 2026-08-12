import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';

import {
  generationSchema,
  httpUrlSchema,
  isoDateTimeSchema,
  runIdSchema,
  runResourceLimitsSchema
} from '@kross/protocol';
import { z } from 'zod';

import { OrchestratorError } from './errors';
import type { OrchestratorService } from './orchestratorService';
import type {
  AuthorizationContext,
  OrchestratorScope
} from './types';

const MAX_BODY_BYTES = 64 * 1024;
const tokenSchema = z.string().min(32).max(4096).regex(/^[\x21-\x7e]+$/);
const launchSchema = z
  .object({
    runId: runIdSchema,
    generation: generationSchema,
    leaseId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    runToken: tokenSchema,
    runSpecUrl: httpUrlSchema,
    tokenExpiresAt: isoDateTimeSchema,
    resourceLimits: runResourceLimitsSchema,
    networkAccess: z.enum([
      'restricted',
      'connector_proxy_only',
      'disabled'
    ])
  })
  .strict();
const executionKeySchema = z
  .object({ runId: runIdSchema, generation: generationSchema })
  .strict();
const reapSchema = z
  .object({
    activeRuns: z.array(executionKeySchema).max(10_000),
    terminalRunIds: z.array(runIdSchema).max(10_000),
    now: isoDateTimeSchema.optional()
  })
  .strict();

export interface OrchestratorHttpOptions {
  serviceToken: string;
  serviceId?: string;
  scopes?: readonly OrchestratorScope[];
}

export function createOrchestratorHttpServer(
  service: OrchestratorService,
  options: OrchestratorHttpOptions
): Server {
  if (!tokenSchema.safeParse(options.serviceToken).success) {
    throw new Error('Orchestrator service token 必须是至少 32 字节的可打印 ASCII');
  }
  const context: AuthorizationContext = {
    principal: {
      serviceId: options.serviceId ?? 'control-plane',
      scopes: options.scopes ?? [
        'run:launch',
        'run:cancel',
        'run:inspect',
        'run:reap'
      ]
    }
  };

  return createServer(async (request, response) => {
    try {
      authenticate(request, options.serviceToken);
      const method = request.method ?? 'GET';
      const path = new URL(request.url ?? '/', 'http://orchestrator.internal')
        .pathname;
      if (method === 'GET' && path === '/healthz') {
        const result = await service.health();
        sendJson(response, result.ok ? 200 : 503, result);
        return;
      }
      if (method !== 'POST') {
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        return;
      }
      const body = await readJsonBody(request);
      if (path === '/internal/runs/launch') {
        sendJson(response, 200, await service.launch(context, launchSchema.parse(body)));
        return;
      }
      if (path === '/internal/runs/cancel') {
        const input = executionKeySchema.parse(body);
        sendJson(
          response,
          200,
          await service.cancel(context, input.runId, input.generation)
        );
        return;
      }
      if (path === '/internal/runs/inspect') {
        const input = executionKeySchema.parse(body);
        sendJson(
          response,
          200,
          await service.inspect(context, input.runId, input.generation)
        );
        return;
      }
      if (path === '/internal/runs/reap') {
        sendJson(response, 200, await service.reap(context, reapSchema.parse(body)));
        return;
      }
      sendJson(response, 404, { error: { code: 'NOT_FOUND' } });
    } catch (error) {
      handleError(response, error);
    }
  });
}

function authenticate(request: IncomingMessage, expectedToken: string): void {
  const authorization = request.headers.authorization;
  const supplied = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const left = Buffer.from(supplied);
  const right = Buffer.from(expectedToken);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new OrchestratorError('UNAUTHORIZED', '内部服务认证失败', 401);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) {
      throw new OrchestratorError('BODY_TOO_LARGE', '请求体过大', 413);
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new OrchestratorError('INVALID_JSON', '请求体不是有效 JSON', 400);
  }
}

function handleError(response: ServerResponse, error: unknown): void {
  if (error instanceof z.ZodError) {
    sendJson(response, 400, {
      error: { code: 'INVALID_INPUT', issues: error.issues }
    });
    return;
  }
  if (error instanceof OrchestratorError) {
    sendJson(response, error.statusCode, {
      error: { code: error.code, message: error.message }
    });
    return;
  }
  sendJson(response, 500, { error: { code: 'INTERNAL_ERROR' } });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}
