import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ConfigPersistenceOptions } from '../config/configImport';
import { loadKrossConfig, resolveKrossConfigPath } from '../config/configImport';
import type { McpServerConfig, McpServersConfig } from './types';
import type { ToolRisk } from '../tools/toolGateway';

const TOOL_RISKS: ToolRisk[] = ['read', 'write', 'execute', 'network'];

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
      typeof (entry as { command?: unknown }).command === 'string'
  );
}

function normalizeServerConfig(value: unknown): McpServerConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
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
    command,
    ...(args ? { args } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(entry.disabled === true ? { disabled: true } : {}),
    ...(typeof entry.cwd === 'string' && entry.cwd.trim()
      ? { cwd: entry.cwd.trim() }
      : {}),
    ...(risk ? { risk } : {}),
    ...(connectTimeoutMs ? { connectTimeoutMs } : {})
  };
}

/** Exposed for tests: which config path would be used for kross config. */
export function resolveKrossConfigPathForMcp(
  options: ConfigPersistenceOptions = {}
): string {
  return resolveKrossConfigPath(options);
}
