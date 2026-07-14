import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface StdioJsonRpcClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Default 12s */
  requestTimeoutMs?: number;
  spawnImpl?: typeof spawn;
}

/**
 * Minimal MCP-compatible stdio JSON-RPC client.
 * Framing: `Content-Length: N\r\n\r\n<body>` (same as MCP TypeScript SDK).
 */
export class StdioJsonRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  private readonly requestTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly options: StdioJsonRpcClientOptions;

  constructor(options: StdioJsonRpcClientOptions) {
    super();
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 12_000;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.child) {
      return;
    }
    const child = this.spawnImpl(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
      this.emit('error', error);
    });
    child.on('close', (code, signal) => {
      this.closed = true;
      this.failAll(
        new Error(
          `MCP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
        )
      );
      this.emit('close', code, signal);
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed || !this.child) {
      throw new Error('MCP client is not running');
    }
    const id = this.nextId;
    this.nextId += 1;
    const message: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params })
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeMessage(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child) {
      throw new Error('MCP client is not running');
    }
    const message: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params })
    };
    this.writeMessage(message);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failAll(new Error('MCP client closed'));
    const child = this.child;
    this.child = undefined;
    if (!child) {
      return;
    }
    child.stdin.end();
    const exited = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
    });
    child.kill('SIGTERM');
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2000);
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 2500))
    ]);
    clearTimeout(force);
  }

  private writeMessage(message: JsonRpcMessage): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
    this.child!.stdin.write(Buffer.concat([header, body]));
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const parsed = tryReadFramedMessage(this.buffer);
      if (!parsed) {
        break;
      }
      this.buffer = parsed.rest;
      this.handleMessage(parsed.message);
    }
  }

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') {
      return;
    }
    const message = raw as JsonRpcResponse;
    if (!('id' in message) || message.id === null || message.id === undefined) {
      // notification from server — ignore for P0
      this.emit('notification', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(
          `MCP error ${message.error.code}: ${message.error.message}`
        )
      );
      return;
    }
    pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

/** Exported for unit tests. */
export function tryReadFramedMessage(
  buffer: Buffer
): { message: unknown; rest: Buffer } | undefined {
  const headerEnd = indexOfHeaderEnd(buffer);
  if (headerEnd < 0) {
    return undefined;
  }
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const match = /Content-Length:\s*(\d+)/i.exec(headerText);
  if (!match?.[1]) {
    // Drop one line to avoid infinite loop on garbage
    const nl = buffer.indexOf(0x0a);
    if (nl < 0) {
      return undefined;
    }
    return tryReadFramedMessage(buffer.subarray(nl + 1));
  }
  const length = Number(match[1]);
  if (!Number.isFinite(length) || length < 0) {
    return undefined;
  }
  const bodyStart = headerEnd + 4; // \r\n\r\n
  if (buffer.length < bodyStart + length) {
    return undefined;
  }
  const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
  const rest = buffer.subarray(bodyStart + length);
  try {
    return { message: JSON.parse(body) as unknown, rest };
  } catch {
    return { message: undefined, rest };
  }
}

function indexOfHeaderEnd(buffer: Buffer): number {
  // \r\n\r\n
  for (let i = 0; i < buffer.length - 3; i += 1) {
    if (
      buffer[i] === 0x0d &&
      buffer[i + 1] === 0x0a &&
      buffer[i + 2] === 0x0d &&
      buffer[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}
