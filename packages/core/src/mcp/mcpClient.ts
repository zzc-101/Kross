import { StdioJsonRpcClient, type StdioJsonRpcClientOptions } from './jsonRpcStdio';
import type {
  McpTransport,
  McpTransportDiagnosticListener,
  McpTransportRequestOptions
} from './transport';
import { McpTransportSessionExpiredError } from './transport';
import type { McpCallToolResult, McpToolInfo } from './types';

export const MCP_PROTOCOL_VERSION = '2025-11-25';

export interface McpStdioClientOptions extends StdioJsonRpcClientOptions {
  clientName?: string;
  clientVersion?: string;
}

export interface McpClientOptions {
  clientName?: string;
  clientVersion?: string;
}

export interface McpToolClient {
  connect(): Promise<void>;
  listTools(options?: McpTransportRequestOptions): Promise<McpToolInfo[]>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: McpTransportRequestOptions
  ): Promise<McpCallToolResult>;
  onDiagnostic(listener: McpTransportDiagnosticListener): () => void;
  close(): Promise<void>;
}

/**
 * Thin MCP protocol client: initialize → tools/list → tools/call.
 */
export class McpClient implements McpToolClient {
  private initialized = false;
  private closePromise: Promise<void> | undefined;
  private connectPromise: Promise<void> | undefined;
  private readonly clientName: string;
  private readonly clientVersion: string;

  constructor(
    readonly transport: McpTransport,
    options: McpClientOptions = {}
  ) {
    this.clientName = options.clientName ?? 'kross';
    this.clientVersion = options.clientVersion ?? '0.1.0';
  }

  async connect(): Promise<void> {
    if (this.closePromise) {
      throw new Error('MCP client is closed');
    }
    if (this.initialized) return;
    this.connectPromise ??= this.initialize().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async initialize(): Promise<void> {
    await this.transport.start();
    const result = (await this.transport.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        // Server-to-client roots and sampling requests are not implemented.
      },
      clientInfo: {
        name: this.clientName,
        version: this.clientVersion
      }
    })) as { protocolVersion?: unknown };
    const negotiatedVersion =
      typeof result?.protocolVersion === 'string'
        ? result.protocolVersion
        : MCP_PROTOCOL_VERSION;
    this.transport.setProtocolVersion?.(negotiatedVersion);
    await this.transport.notify('notifications/initialized', {});
    this.initialized = true;
  }

  async listTools(
    options?: McpTransportRequestOptions
  ): Promise<McpToolInfo[]> {
    this.ensureInitialized();
    const result = (await this.requestWithReconnect(
      'tools/list',
      {},
      options
    )) as {
      tools?: McpToolInfo[];
    };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options?: McpTransportRequestOptions
  ): Promise<McpCallToolResult> {
    this.ensureInitialized();
    const result = await this.requestWithReconnect(
      'tools/call',
      {
        name,
        arguments: args
      },
      options
    );
    return (result ?? {}) as McpCallToolResult;
  }

  private async requestWithReconnect(
    method: string,
    params: unknown,
    options?: McpTransportRequestOptions
  ): Promise<unknown> {
    try {
      return await this.transport.request(method, params, options);
    } catch (error) {
      if (!(error instanceof McpTransportSessionExpiredError)) {
        throw error;
      }
      options?.signal?.throwIfAborted();
      this.initialized = false;
      await this.connect();
      return this.transport.request(method, params, options);
    }
  }

  close(): Promise<void> {
    this.initialized = false;
    this.closePromise ??= this.transport.close();
    return this.closePromise;
  }

  onDiagnostic(listener: McpTransportDiagnosticListener): () => void {
    return this.transport.onDiagnostic(listener);
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MCP client is not initialized');
    }
  }
}

/** Backward-compatible stdio composition over the transport-neutral client. */
export class McpStdioClient extends McpClient {
  private readonly rpc: StdioJsonRpcClient;

  constructor(options: McpStdioClientOptions) {
    const rpc = new StdioJsonRpcClient(options);
    super(rpc, options);
    this.rpc = rpc;
  }

  get rpcClient(): StdioJsonRpcClient {
    return this.rpc;
  }
}
