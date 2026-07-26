import { z } from 'zod';

import type {
  ToolDefinition,
  ToolGateway,
  ToolHandlerResult
} from '../tools/toolGateway';
import { loadMcpServersConfig, type LoadMcpConfigOptions } from './config';
import {
  McpClient,
  McpStdioClient,
  type McpToolClient
} from './mcpClient';
import { buildMcpToolName, inferMcpToolRisk } from './risk';
import { StreamableHttpTransport } from './streamableHttp';
import type {
  McpCallToolResult,
  McpCatalogPrompt,
  McpCatalogResource,
  McpConnectResult,
  McpSelectedPrompt,
  McpSelectedResource,
  McpManagerSnapshot,
  McpServerConfig,
  McpToolInfo
} from './types';

const mcpInputSchema = z.record(z.string(), z.unknown());

export interface McpManager {
  /** Connect results for UI/debug. */
  snapshot(): McpManagerSnapshot;
  listResources(signal?: AbortSignal): Promise<McpCatalogResource[]>;
  readResource(
    serverId: string,
    uri: string,
    signal?: AbortSignal
  ): Promise<McpSelectedResource>;
  listPrompts(signal?: AbortSignal): Promise<McpCatalogPrompt[]>;
  getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<McpSelectedPrompt>;
  close(): Promise<void>;
}

export interface ConnectMcpOptions extends LoadMcpConfigOptions {
  /** Workspace cwd; used as default process cwd for servers without explicit cwd. */
  workspaceRoot?: string;
  env?: Record<string, string | undefined>;
  httpFetch?: typeof fetch;
  maxResourceBytes?: number;
  maxPromptBytes?: number;
  /** Inject clients in tests. */
  createClient?: (
    serverId: string,
    config: McpServerConfig
  ) => McpToolClient;
  /** Soft-fail callback (stderr / startup logs). */
  onWarning?: (message: string) => void;
}

/**
 * Connect configured MCP servers, list tools, register into ToolGateway.
 * Failures for individual servers are soft — other servers still load.
 */
export async function connectAndRegisterMcpTools(
  gateway: ToolGateway,
  options: ConnectMcpOptions = {}
): Promise<McpManager> {
  const servers = loadMcpServersConfig(options);
  const clients: McpToolClient[] = [];
  const clientsByServer = new Map<string, McpToolClient>();
  const unsubscribeDiagnostics: Array<() => void> = [];
  const results: McpConnectResult[] = [];
  const registeredToolNames: string[] = [];
  const warn = options.onWarning ?? (() => undefined);

  for (const [serverId, config] of Object.entries(servers)) {
    if (config.disabled) {
      results.push({
        serverId,
        toolNames: [],
        error: 'disabled'
      });
      continue;
    }

    let client: McpToolClient | undefined;
    try {
      client =
        options.createClient?.(serverId, config) ??
        createConfiguredClient(config, options);
      unsubscribeDiagnostics.push(
        client.onDiagnostic((diagnostic) => {
          if (diagnostic.level !== 'debug') {
            const message =
              diagnostic.code === 'stderr'
                ? 'server emitted stderr output'
                : diagnostic.message;
            warn(
              `MCP server "${serverId}" ${diagnostic.code}: ${message}`
            );
          }
        })
      );

      await client.connect();
      const capabilities = client.getCapabilities();
      const tools =
        capabilities.tools === undefined && Object.keys(capabilities).length > 0
          ? []
          : await client.listTools();
      const names: string[] = [];

      for (const tool of tools) {
        const definition = createMcpToolDefinition({
          serverId,
          tool,
          client,
          serverRisk:
            config.risk ??
            (config.transport === 'streamable-http' ? 'network' : undefined)
        });
        if (gatewayHasTool(gateway, definition.name)) {
          warn(
            `MCP tool name collision, skipped: ${definition.name} (server ${serverId})`
          );
          continue;
        }
        gateway.register(definition);
        names.push(definition.name);
        registeredToolNames.push(definition.name);
      }

      clients.push(client);
      clientsByServer.set(serverId, client);
      results.push({
        serverId,
        toolNames: names,
        capabilities: {
          tools:
            capabilities.tools !== undefined ||
            Object.keys(capabilities).length === 0,
          resources: capabilities.resources !== undefined,
          prompts: capabilities.prompts !== undefined
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`MCP server "${serverId}" failed: ${message}`);
      results.push({ serverId, toolNames: [], error: message });
      if (client) {
        try {
          await client.close();
        } catch {
          // ignore
        }
      }
    }
  }

  return {
    snapshot: () => ({
      results: [...results],
      registeredToolNames: [...registeredToolNames]
    }),
    listResources: (signal) =>
      listCatalogItems(
        clientsByServer,
        'resources',
        signal
      ),
    readResource: async (serverId, uri, signal) => {
      const client = requireMcpClient(clientsByServer, serverId);
      const resource = (await client.listResources({ signal })).find(
        (item) => item.uri === uri
      );
      if (!resource) {
        throw new Error(`MCP resource not found: ${serverId}/${uri}`);
      }
      const result = await client.readResource(uri, { signal });
      enforcePayloadLimit(
        result,
        options.maxResourceBytes ?? 128 * 1024,
        'resource'
      );
      return { serverId, resource, result };
    },
    listPrompts: (signal) =>
      listCatalogItems(
        clientsByServer,
        'prompts',
        signal
      ),
    getPrompt: async (serverId, name, args = {}, signal) => {
      const client = requireMcpClient(clientsByServer, serverId);
      const prompt = (await client.listPrompts({ signal })).find(
        (item) => item.name === name
      );
      if (!prompt) {
        throw new Error(`MCP prompt not found: ${serverId}/${name}`);
      }
      const result = await client.getPrompt(name, args, { signal });
      enforcePayloadLimit(
        result,
        options.maxPromptBytes ?? 64 * 1024,
        'prompt'
      );
      return { serverId, prompt, result };
    },
    close: async () => {
      for (const unsubscribe of unsubscribeDiagnostics.splice(0)) {
        unsubscribe();
      }
      await Promise.all(
        clients.map(async (client) => {
          try {
            await client.close();
          } catch {
            // best-effort
          }
        })
      );
      clients.length = 0;
      clientsByServer.clear();
    }
  };
}

async function listCatalogItems(
  clients: Map<string, McpToolClient>,
  kind: 'resources',
  signal?: AbortSignal
): Promise<McpCatalogResource[]>;
async function listCatalogItems(
  clients: Map<string, McpToolClient>,
  kind: 'prompts',
  signal?: AbortSignal
): Promise<McpCatalogPrompt[]>;
async function listCatalogItems(
  clients: Map<string, McpToolClient>,
  kind: 'resources' | 'prompts',
  signal?: AbortSignal
): Promise<Array<McpCatalogResource | McpCatalogPrompt>> {
  const catalog: Array<McpCatalogResource | McpCatalogPrompt> = [];
  for (const [serverId, client] of clients) {
    const capabilities = client.getCapabilities();
    if (capabilities[kind] === undefined) continue;
    try {
      const items =
        kind === 'resources'
          ? await client.listResources({ signal })
          : await client.listPrompts({ signal });
      catalog.push(...items.map((item) => ({ ...item, serverId })));
    } catch (error) {
      throw new Error(
        `MCP ${kind} listing failed for ${serverId}: ${safeMcpError(error)}`
      );
    }
  }
  return catalog;
}

function requireMcpClient(
  clients: Map<string, McpToolClient>,
  serverId: string
): McpToolClient {
  const client = clients.get(serverId);
  if (!client) throw new Error(`MCP server is not connected: ${serverId}`);
  return client;
}

function enforcePayloadLimit(
  value: unknown,
  limit: number,
  kind: 'resource' | 'prompt'
): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > limit) {
    throw new Error(
      `MCP ${kind} payload exceeds ${limit} bytes (received ${bytes})`
    );
  }
}

function safeMcpError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sync convenience for startup paths that cannot await easily:
 * kicks off async connect and returns a manager handle immediately.
 * Tools appear after connect completes (race with first user turn).
 *
 * Prefer `connectAndRegisterMcpTools` when the caller can await.
 */
export function startMcpRegistration(
  gateway: ToolGateway,
  options: ConnectMcpOptions = {}
): {
  ready: Promise<McpManager>;
  getManager: () => McpManager | undefined;
} {
  let manager: McpManager | undefined;
  const ready = connectAndRegisterMcpTools(gateway, options).then((m) => {
    manager = m;
    return m;
  });
  return {
    ready,
    getManager: () => manager
  };
}

export function createMcpToolDefinition(input: {
  serverId: string;
  tool: McpToolInfo;
  client: McpToolClient;
  serverRisk?: import('../tools/toolGateway').ToolRisk;
}): ToolDefinition<Record<string, unknown>> {
  const toolName = buildMcpToolName(input.serverId, input.tool.name);
  const risk = inferMcpToolRisk(input.tool, input.serverRisk);
  const description =
    input.tool.description?.trim() ||
    `MCP tool ${input.tool.name} from server ${input.serverId}`;
  const parameters =
    input.tool.inputSchema &&
    typeof input.tool.inputSchema === 'object' &&
    !Array.isArray(input.tool.inputSchema)
      ? input.tool.inputSchema
      : {
          type: 'object',
          properties: {},
          additionalProperties: true
        };

  return {
    name: toolName,
    description: `[MCP:${input.serverId}] ${description}`,
    risk,
    category: `mcp:${input.serverId}`,
    parameters,
    inputSchema: mcpInputSchema,
    // MCP calls can be slow (network servers)
    timeoutMs: 120_000,
    retry: false,
    execute: async ({ input: args, signal }) => {
      if (signal.aborted) {
        throw new Error('MCP tool call aborted');
      }
      const result = await input.client.callTool(input.tool.name, args ?? {}, {
        signal,
        timeoutMs: 120_000
      });
      return formatMcpToolResult(result);
    }
  };
}

function createConfiguredClient(
  config: McpServerConfig,
  options: ConnectMcpOptions
): McpToolClient {
  if (config.transport === 'streamable-http') {
    const env = options.env ?? process.env;
    const token = config.authorization
      ? env[config.authorization.env]
      : undefined;
    if (config.authorization && !token) {
      throw new Error(
        `MCP bearer token environment variable is not set: ${config.authorization.env}`
      );
    }
    return new McpClient(
      new StreamableHttpTransport({
        endpoint: config.url,
        headers: config.headers,
        bearerToken: token,
        requestTimeoutMs: config.connectTimeoutMs ?? 12_000,
        fetchImpl: options.httpFetch
      })
    );
  }
  return new McpStdioClient({
    command: config.command,
    args: config.args,
    env: {
      ...options.env,
      ...config.env
    },
    cwd: config.cwd ?? options.workspaceRoot,
    requestTimeoutMs: config.connectTimeoutMs ?? 12_000
  });
}

export function formatMcpToolResult(result: McpCallToolResult): ToolHandlerResult {
  const content = formatMcpContent(result);
  if (result.isError) {
    return {
      status: 'failed',
      content,
      summary: truncate(`MCP error: ${content}`, 200),
      data: {
        error: {
          source: 'mcp',
          category: 'protocol',
          retryable: false,
          recovery: '检查 MCP 服务返回和工具参数后再试。'
        }
      }
    };
  }
  return {
    content,
    summary: truncate(content.replace(/\s+/g, ' ').trim() || 'MCP ok', 200),
    data: result.structuredContent ?? { content: result.content }
  };
}

function formatMcpContent(result: McpCallToolResult): string {
  const parts = result.content;
  if (!Array.isArray(parts) || parts.length === 0) {
    if (result.structuredContent !== undefined) {
      return JSON.stringify(result.structuredContent, null, 2);
    }
    return result.isError ? 'MCP tool returned an error' : '(empty MCP result)';
  }
  return parts
    .map((part) => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
      if (typeof part.text === 'string') {
        return part.text;
      }
      return JSON.stringify(part);
    })
    .join('\n');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function gatewayHasTool(gateway: ToolGateway, name: string): boolean {
  return gateway.listTools().some((tool) => tool.name === name);
}
