import type { ToolRisk } from '../tools/toolGateway';
import type { McpToolAnnotations, McpToolInfo } from './types';

/**
 * Infer Gateway risk for an MCP tool.
 * Prefer server-level override; else annotations; default `network` (ask).
 */
export function inferMcpToolRisk(
  tool: McpToolInfo,
  serverRisk?: ToolRisk
): ToolRisk {
  if (serverRisk) {
    return serverRisk;
  }
  return riskFromAnnotations(tool.annotations);
}

export function riskFromAnnotations(
  annotations: McpToolAnnotations | undefined
): ToolRisk {
  if (!annotations) {
    return 'network';
  }
  if (annotations.readOnlyHint === true) {
    return 'read';
  }
  if (annotations.destructiveHint === true) {
    return 'write';
  }
  if (annotations.openWorldHint === true) {
    return 'network';
  }
  return 'network';
}

/** Sanitize server/tool fragments for Gateway tool names. */
export function sanitizeMcpNamePart(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'tool';
}

export function buildMcpToolName(serverId: string, toolName: string): string {
  return `${sanitizeMcpNamePart(serverId)}__${sanitizeMcpNamePart(toolName)}`;
}
