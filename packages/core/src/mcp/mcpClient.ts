import { StdioJsonRpcClient, type StdioJsonRpcClientOptions } from './jsonRpcStdio';
import type { McpCallToolResult, McpToolInfo } from './types';

const PROTOCOL_VERSION = '2024-11-05';

export interface McpStdioClientOptions extends StdioJsonRpcClientOptions {
  clientName?: string;
  clientVersion?: string;
}

/**
 * Thin MCP client over stdio JSON-RPC: initialize → tools/list → tools/call.
 */
export class McpStdioClient {
  private readonly rpc: StdioJsonRpcClient;
  private initialized = false;
  private readonly clientName: string;
  private readonly clientVersion: string;

  constructor(options: McpStdioClientOptions) {
    this.rpc = new StdioJsonRpcClient(options);
    this.clientName = options.clientName ?? 'kross';
    this.clientVersion = options.clientVersion ?? '0.1.0';
  }

  get rpcClient(): StdioJsonRpcClient {
    return this.rpc;
  }

  async connect(): Promise<void> {
    this.rpc.start();
    await this.rpc.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        roots: { listChanged: false },
        sampling: {}
      },
      clientInfo: {
        name: this.clientName,
        version: this.clientVersion
      }
    });
    this.rpc.notify('notifications/initialized', {});
    this.initialized = true;
  }

  async listTools(): Promise<McpToolInfo[]> {
    this.ensureInitialized();
    const result = (await this.rpc.request('tools/list', {})) as {
      tools?: McpToolInfo[];
    };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<McpCallToolResult> {
    this.ensureInitialized();
    const result = await this.rpc.request('tools/call', {
      name,
      arguments: args
    });
    return (result ?? {}) as McpCallToolResult;
  }

  async close(): Promise<void> {
    this.initialized = false;
    await this.rpc.close();
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MCP client is not initialized');
    }
  }
}
