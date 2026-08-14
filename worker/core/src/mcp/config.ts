import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ConfigPersistenceOptions } from '../config/configImport';
import { loadKrossConfig, resolveKrossConfigPath } from '../config/configImport';
import type { McpServerConfig, McpServersConfig } from './types';
import type { ToolRisk } from '../tools/toolGateway';

const TOOL_RISKS: ToolRisk[] = ['read', 'write', 'execute', 'network'];
const RESERVED_HTTP_HEADERS = new Set([
  'accept',
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id'
]);

export interface LoadMcpConfigOptions extends ConfigPersistenceOptions {
  /** Optional absolute path override for mcp.json */
  mcpConfigPath?: string;
}

/**
 * Load MCP server map.
 * Merge order (later wins on same server id):
 * 1. `~/.kross/mcp.json` → `{ mcpServers }` or bare map
 * 2. `~/.kross/config.json` → `mcpServers`
 */
export function loadMcpServersConfig(
  options: LoadMcpConfigOptions = {}
): McpServersConfig {
  const fromFile = readMcpJson(options);
  const fromKross = loadKrossConfig(options)?.mcpServers;
  return {
    ...normalizeServersMap(fromFile),
    ...normalizeServersMap(fromKross)
  };
}

export function resolveMcpConfigPath(
  options: LoadMcpConfigOptions = {}
): string {
  if (options.mcpConfigPath) {
    return options.mcpConfigPath;
  }
  const krossRoot =
    options.krossHome ?? join(options.homeDir ?? homedir(), '.kross');
  return join(krossRoot, 'mcp.json');
}

function readMcpJson(options: LoadMcpConfigOptions): unknown {
  const path = resolveMcpConfigPath(options);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeServersMap(value: unknown): McpServersConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const root = value as Record<string, unknown>;
  const map =
    root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : // bare map of serverId → config (if it looks like servers, not a full kross config)
        looksLikeServersMap(root)
        ? root
        : {};

  const out: McpServersConfig = {};
  for (const [id, entry] of Object.entries(map)) {
    const normalized = normalizeServerConfig(entry);
    if (normalized) {
      out[id] = normalized;
    }
  }
  return out;
}

function looksLikeServersMap(root: Record<string, unknown>): boolean {
  // Avoid treating full kross config (llm/locale/setup) as server map.
  if ('llm' in root || 'locale' in root || 'setup' in root) {
    return false;
  }
  const values = Object.values(root);
  if (values.length === 0) {
    return false;
  }
  return values.every(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      (typeof (entry as { command?: unknown }).command === 'string' ||
        (entry as { transport?: unknown }).transport === 'streamable-http')
  );
}

function normalizeServerConfig(value: unknown): McpServerConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  const common = normalizeCommonConfig(entry);
  if (entry.transport === 'streamable-http') {
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!isHttpUrl(url)) return undefined;
    const headers = normalizeHttpHeaders(entry.headers);
    const authorization = normalizeHttpAuthorization(entry.authorization);
    return {
      transport: 'streamable-http',
      url,
      ...common,
      ...(headers ? { headers } : {}),
      ...(authorization ? { authorization } : {})
    };
  }

  const command = typeof entry.command === 'string' ? entry.command.trim() : '';
  if (!command) {
    return undefined;
  }
  const args = Array.isArray(entry.args)
    ? entry.args.filter((item): item is string => typeof item === 'string')
    : undefined;
  const env =
    entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
      ? Object.fromEntries(
          Object.entries(entry.env as Record<string, unknown>).filter(
            (pair): pair is [string, string] => typeof pair[1] === 'string'
          )
        )
      : undefined;
  return {
    transport: 'stdio',
    command,
    ...(args ? { args } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(typeof entry.cwd === 'string' && entry.cwd.trim()
      ? { cwd: entry.cwd.trim() }
      : {}),
    ...common
  };
}

function normalizeCommonConfig(
  entry: Record<string, unknown>
): Pick<
  McpServerConfig,
  'disabled' | 'risk' | 'connectTimeoutMs'
> {
  const risk =
    typeof entry.risk === 'string' && TOOL_RISKS.includes(entry.risk as ToolRisk)
      ? (entry.risk as ToolRisk)
      : undefined;
  const connectTimeoutMs =
    typeof entry.connectTimeoutMs === 'number' &&
    Number.isFinite(entry.connectTimeoutMs) &&
    entry.connectTimeoutMs > 0
      ? Math.floor(entry.connectTimeoutMs)
      : undefined;
  return {
    ...(entry.disabled === true ? { disabled: true } : {}),
    ...(risk ? { risk } : {}),
    ...(connectTimeoutMs ? { connectTimeoutMs } : {})
  };
}

function normalizeHttpHeaders(
  value: unknown
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (
      typeof headerValue === 'string' &&
      isHttpHeaderName(name) &&
      !RESERVED_HTTP_HEADERS.has(name.toLowerCase()) &&
      !headerValue.includes('\r') &&
      !headerValue.includes('\n')
    ) {
      headers[name] = headerValue;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeHttpAuthorization(
  value: unknown
): { type: 'bearer-env'; env: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  const env = typeof entry.env === 'string' ? entry.env.trim() : '';
  if (
    entry.type !== 'bearer-env' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)
  ) {
    return undefined;
  }
  return { type: 'bearer-env', env };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isHttpHeaderName(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

/** Exposed for tests: which config path would be used for kross config. */
export function resolveKrossConfigPathForMcp(
  options: ConfigPersistenceOptions = {}
): string {
  return resolveKrossConfigPath(options);
}
