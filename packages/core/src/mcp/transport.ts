export interface McpTransportRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpTransportDiagnostic {
  level: 'debug' | 'warning' | 'error';
  code: 'stderr' | 'transport-error' | 'transport-closed';
  message: string;
}

export type McpTransportDiagnosticListener = (
  diagnostic: McpTransportDiagnostic
) => void;

export class McpTransportSessionExpiredError extends Error {
  constructor(message = 'MCP transport session expired') {
    super(message);
    this.name = 'McpTransportSessionExpiredError';
  }
}

/**
 * JSON-RPC lifecycle required by the MCP protocol client.
 *
 * Transport implementations own connection establishment, request
 * cancellation/timeouts, diagnostics, and idempotent resource cleanup.
 */
export interface McpTransport {
  readonly kind: string;
  start(): void | Promise<void>;
  setProtocolVersion?(version: string): void;
  request(
    method: string,
    params?: unknown,
    options?: McpTransportRequestOptions
  ): Promise<unknown>;
  notify(method: string, params?: unknown): void | Promise<void>;
  onDiagnostic(listener: McpTransportDiagnosticListener): () => void;
  close(): Promise<void>;
}
