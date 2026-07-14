import type { ToolRisk } from '../tools/toolGateway';

/** One MCP server entry (Claude Desktop / Cursor compatible shape). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** When true, skip connect/register. */
  disabled?: boolean;
  cwd?: string;
  /**
   * Override default risk for all tools from this server.
   * Default: inferred from tool annotations, else `network` (requires approval).
   */
  risk?: ToolRisk;
  /** Connect timeout in ms (default 12_000). */
  connectTimeoutMs?: number;
}

export type McpServersConfig = Record<string, McpServerConfig>;

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpCallToolResult {
  content?: McpContentItem[];
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
}

export interface McpConnectResult {
  serverId: string;
  toolNames: string[];
  error?: string;
}

export interface McpManagerSnapshot {
  results: McpConnectResult[];
  registeredToolNames: string[];
}
