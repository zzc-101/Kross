import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse
} from './jsonRpcStdio';
import type {
  McpTransport,
  McpTransportDiagnostic,
  McpTransportDiagnosticListener,
  McpTransportRequestOptions
} from './transport';
import { McpTransportSessionExpiredError } from './transport';

export interface StreamableHttpTransportOptions {
  endpoint: string;
  headers?: Record<string, string>;
  bearerToken?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  protocolVersion?: string;
  maxReconnects?: number;
}

export class McpHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly resourceMetadata?: string,
    readonly scope?: string
  ) {
    super(message);
    this.name = 'McpHttpError';
  }
}

export class McpSessionExpiredError extends McpTransportSessionExpiredError {
  readonly status = 404;

  constructor() {
    super('MCP HTTP session expired');
    this.name = 'McpSessionExpiredError';
  }
}

export class StreamableHttpTransport implements McpTransport {
  readonly kind = 'streamable-http';
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly bearerToken?: string;
  private readonly requestTimeoutMs: number;
  private readonly maxReconnects: number;
  private readonly diagnostics = new Set<McpTransportDiagnosticListener>();
  private readonly activeRequests = new Set<AbortController>();
  private nextId = 1;
  private sessionId?: string;
  private protocolVersion: string;
  private protocolNegotiated = false;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: StreamableHttpTransportOptions) {
    this.endpoint = validateEndpoint(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = { ...options.headers };
    this.bearerToken = options.bearerToken;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 12_000;
    this.protocolVersion = options.protocolVersion ?? '2025-11-25';
    this.maxReconnects = options.maxReconnects ?? 3;
  }

  start(): void {
    if (this.closed) {
      throw new Error('MCP Streamable HTTP transport is closed');
    }
  }

  setProtocolVersion(version: string): void {
    if (version.trim()) {
      this.protocolVersion = version;
      this.protocolNegotiated = true;
    }
  }

  async request(
    method: string,
    params?: unknown,
    options: McpTransportRequestOptions = {}
  ): Promise<unknown> {
    this.ensureOpen();
    const id = this.nextId;
    this.nextId += 1;
    const message: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params })
    };
    const request = this.createRequestSignal(options);
    try {
      const response = await this.post(message, request.signal);
      this.captureSession(response, method);
      if (response.status === 404 && this.sessionId) {
        this.sessionId = undefined;
        this.protocolNegotiated = false;
        throw new McpSessionExpiredError();
      }
      await this.assertOk(response);
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return parseJsonRpcResponse(await response.json(), id);
      }
      if (contentType.includes('text/event-stream')) {
        return await this.readSseResponse(response, id, request.signal);
      }
      throw new Error(
        `MCP HTTP response has unsupported Content-Type: ${contentType || '(missing)'}`
      );
    } catch (error) {
      if (request.signal.aborted) {
        void this.sendCancellation(id, abortMessage(request.signal.reason));
        throw request.normalizeAbort(error);
      }
      throw error;
    } finally {
      request.cleanup();
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.ensureOpen();
    const message: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params })
    };
    const request = this.createRequestSignal({});
    try {
      const response = await this.post(message, request.signal);
      if (response.status === 404 && this.sessionId) {
        this.sessionId = undefined;
        this.protocolNegotiated = false;
        throw new McpSessionExpiredError();
      }
      await this.assertOk(response);
      if (response.status !== 202) {
        throw new Error(
          `MCP HTTP notification expected 202, received ${response.status}`
        );
      }
    } catch (error) {
      if (request.signal.aborted) {
        throw request.normalizeAbort(error);
      }
      throw error;
    } finally {
      request.cleanup();
    }
  }

  onDiagnostic(listener: McpTransportDiagnosticListener): () => void {
    this.diagnostics.add(listener);
    return () => this.diagnostics.delete(listener);
  }

  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.closed = true;
    for (const controller of this.activeRequests) {
      controller.abort('MCP HTTP transport closed');
    }
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    if (!sessionId) return;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'DELETE',
        headers: this.requestHeaders({ sessionId }),
        signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, 2000))
      });
      if (!response.ok && response.status !== 404 && response.status !== 405) {
        this.emitDiagnostic({
          level: 'warning',
          code: 'transport-error',
          message: `MCP session DELETE returned HTTP ${response.status}`
        });
      }
    } catch (error) {
      this.emitDiagnostic({
        level: 'warning',
        code: 'transport-error',
        message: safeErrorMessage(error)
      });
    }
  }

  private async post(
    message: JsonRpcRequest | JsonRpcNotification,
    signal: AbortSignal
  ): Promise<Response> {
    return this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(message),
      signal
    });
  }

  private async readSseResponse(
    initialResponse: Response,
    requestId: number,
    signal: AbortSignal
  ): Promise<unknown> {
    let response = initialResponse;
    let lastEventId: string | undefined;
    let retryMs = 0;
    for (let reconnects = 0; reconnects <= this.maxReconnects; reconnects += 1) {
      const consumed = await consumeSse(response, requestId, signal);
      lastEventId = consumed.lastEventId ?? lastEventId;
      retryMs = consumed.retryMs ?? retryMs;
      if (consumed.response) {
        return parseJsonRpcResponse(consumed.response, requestId);
      }
      if (!lastEventId || reconnects === this.maxReconnects) {
        break;
      }
      if (retryMs > 0) {
        await waitForRetry(retryMs, signal);
      }
      response = await this.fetchImpl(this.endpoint, {
        method: 'GET',
        headers: this.requestHeaders({ lastEventId }),
        signal
      });
      await this.assertOk(response);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        throw new Error(
          `MCP SSE resume returned unsupported Content-Type: ${contentType || '(missing)'}`
        );
      }
    }
    throw new Error('MCP SSE stream ended before the JSON-RPC response');
  }

  private requestHeaders(
    options: { lastEventId?: string; sessionId?: string } = {}
  ): Headers {
    const headers = new Headers(this.headers);
    headers.set('Accept', 'application/json, text/event-stream');
    headers.set('Content-Type', 'application/json');
    if (this.bearerToken) {
      headers.set('Authorization', `Bearer ${this.bearerToken}`);
    }
    const sessionId = options.sessionId ?? this.sessionId;
    if (sessionId) headers.set('MCP-Session-Id', sessionId);
    if (this.protocolNegotiated || sessionId) {
      headers.set('MCP-Protocol-Version', this.protocolVersion);
    }
    if (options.lastEventId) {
      headers.set('Last-Event-ID', options.lastEventId);
      headers.set('Accept', 'text/event-stream');
      headers.delete('Content-Type');
    }
    return headers;
  }

  private captureSession(response: Response, method: string): void {
    if (method !== 'initialize') return;
    const sessionId = response.headers.get('MCP-Session-Id');
    if (!sessionId) return;
    if (
      sessionId.length > 1024 ||
      [...sessionId].some((char) => {
        const code = char.charCodeAt(0);
        return code < 0x21 || code > 0x7e;
      })
    ) {
      throw new Error('MCP server returned an invalid session id');
    }
    this.sessionId = sessionId;
  }

  private async assertOk(response: Response): Promise<void> {
    if (response.ok) return;
    const challenge = parseBearerChallenge(
      response.headers.get('WWW-Authenticate')
    );
    throw new McpHttpError(
      `MCP HTTP request failed with ${response.status} ${response.statusText}`,
      response.status,
      challenge.resourceMetadata,
      challenge.scope
    );
  }

  private createRequestSignal(options: McpTransportRequestOptions): {
    signal: AbortSignal;
    cleanup: () => void;
    normalizeAbort: (error: unknown) => Error;
  } {
    const controller = new AbortController();
    this.activeRequests.add(controller);
    let timedOut = false;
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort('request timeout');
    }, options.timeoutMs ?? this.requestTimeoutMs);
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        this.activeRequests.delete(controller);
      },
      normalizeAbort: (error) => {
        if (timedOut) {
          return new Error('MCP HTTP request timed out');
        }
        const normalized = new Error(abortMessage(controller.signal.reason), {
          cause: error
        });
        normalized.name = 'AbortError';
        return normalized;
      }
    };
  }

  private async sendCancellation(
    requestId: number,
    reason: string
  ): Promise<void> {
    if (this.closed) return;
    try {
      const response = await this.post(
        {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId, reason }
        },
        AbortSignal.timeout(Math.min(this.requestTimeoutMs, 2000))
      );
      if (!response.ok && response.status !== 404) {
        this.emitDiagnostic({
          level: 'warning',
          code: 'transport-error',
          message: `MCP cancellation returned HTTP ${response.status}`
        });
      }
    } catch {
      // The local request is already cancelled.
    }
  }

  private emitDiagnostic(diagnostic: McpTransportDiagnostic): void {
    for (const listener of this.diagnostics) {
      listener(diagnostic);
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('MCP Streamable HTTP transport is closed');
    }
  }
}

interface ConsumedSse {
  response?: JsonRpcResponse;
  lastEventId?: string;
  retryMs?: number;
}

async function consumeSse(
  response: Response,
  requestId: number,
  signal: AbortSignal
): Promise<ConsumedSse> {
  if (!response.body) {
    throw new Error('MCP SSE response has no body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastEventId: string | undefined;
  let retryMs: number | undefined;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseSseBlock(block);
        lastEventId = event.id ?? lastEventId;
        retryMs = event.retryMs ?? retryMs;
        if (!event.data) continue;
        const message = JSON.parse(event.data) as JsonRpcResponse;
        if (message.id === requestId) {
          await reader.cancel();
          return { response: message, lastEventId, retryMs };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { lastEventId, retryMs };
}

function parseSseBlock(block: string): {
  data?: string;
  id?: string;
  retryMs?: number;
} {
  const data: string[] = [];
  let id: string | undefined;
  let retryMs: number | undefined;
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    const rawValue = separator < 0 ? '' : rawLine.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'data') data.push(value);
    if (field === 'id' && !value.includes('\0')) id = value;
    if (field === 'retry' && /^\d+$/.test(value)) {
      retryMs = Math.min(Number(value), 30_000);
    }
  }
  return {
    ...(data.length > 0 ? { data: data.join('\n') } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(retryMs !== undefined ? { retryMs } : {})
  };
}

function parseJsonRpcResponse(raw: unknown, requestId: number): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('MCP server returned an invalid JSON-RPC response');
  }
  const response = raw as JsonRpcResponse;
  if (response.jsonrpc !== '2.0') {
    throw new Error('MCP server returned an invalid JSON-RPC version');
  }
  if (response.id !== requestId) {
    throw new Error(
      `MCP JSON-RPC response id mismatch: expected ${requestId}, received ${String(response.id)}`
    );
  }
  if (response.error) {
    throw new Error(
      `MCP error ${response.error.code}: ${response.error.message}`
    );
  }
  return response.result;
}

function parseBearerChallenge(value: string | null): {
  resourceMetadata?: string;
  scope?: string;
} {
  if (!value || !/^Bearer\b/i.test(value)) return {};
  const read = (name: string): string | undefined => {
    const match = new RegExp(`${name}="([^"]+)"`, 'i').exec(value);
    return match?.[1];
  };
  const resourceMetadata = read('resource_metadata');
  const scope = read('scope');
  return {
    ...(resourceMetadata ? { resourceMetadata } : {}),
    ...(scope ? { scope } : {})
  };
}

function validateEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('MCP HTTP endpoint cannot contain credentials or a fragment');
  }
  if (endpoint.protocol === 'https:') return endpoint;
  if (
    endpoint.protocol === 'http:' &&
    (endpoint.hostname === 'localhost' ||
      endpoint.hostname === '127.0.0.1' ||
      endpoint.hostname === '[::1]')
  ) {
    return endpoint;
  }
  throw new Error(
    'MCP Streamable HTTP requires HTTPS except for localhost endpoints'
  );
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(abortMessage(signal.reason)));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new Error(abortMessage(signal.reason)));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function abortMessage(reason: unknown): string {
  return typeof reason === 'string' && reason ? reason : 'MCP request aborted';
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
