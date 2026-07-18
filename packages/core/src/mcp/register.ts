import { z } from 'zod';

import type {
  ToolDefinition,
  ToolGateway,
  ToolHandlerResult
} from '../tools/toolGateway';
import { loadMcpServersConfig, type LoadMcpConfigOptions } from './config';
import { McpStdioClient } from './mcpClient';
import { buildMcpToolName, inferMcpToolRisk } from './risk';
import type {
  McpCallToolResult,
  McpConnectResult,
  McpManagerSnapshot,
  McpServerConfig,
  McpToolInfo
} from './types';

const mcpInputSchema = z.record(z.string(), z.unknown());

export interface McpManager {
  /** Connect results for UI/debug. */
  snapshot(): McpManagerSnapshot;
  close(): Promise<void>;
}

export interface ConnectMcpOptions extends LoadMcpConfigOptions {
  /** Workspace cwd; used as default process cwd for servers without explicit cwd. */
  workspaceRoot?: string;
  env?: Record<string, string | undefined>;
  /** Inject clients in tests. */
  createClient?: (
    serverId: string,
    config: McpServerConfig
  ) => McpStdioClient;
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
  const clients: McpStdioClient[] = [];
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

    let client: McpStdioClient | undefined;
    try {
      client =
        options.createClient?.(serverId, config) ??
        new McpStdioClient({
          command: config.command,
          args: config.args,
          env: {
            ...options.env,
            ...config.env
          },
          cwd: config.cwd ?? options.workspaceRoot,
          requestTimeoutMs: config.connectTimeoutMs ?? 12_000
        });

      await client.connect();
      const tools = await client.listTools();
      const names: string[] = [];

      for (const tool of tools) {
        const definition = createMcpToolDefinition({
          serverId,
          tool,
          client,
          serverRisk: config.risk
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
      results.push({ serverId, toolNames: names });
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
    close: async () => {
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
    }
  };
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
  client: McpStdioClient;
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
      const result = await input.client.callTool(input.tool.name, args ?? {});
      return formatMcpToolResult(result);
    }
  };
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
