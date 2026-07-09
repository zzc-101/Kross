import type { ToolDefinition } from '../toolGateway';
import { createBashTool } from './bash';
import { createEditTool } from './edit';
import { createGlobTool } from './glob';
import { createGrepTool } from './grep';
import { createReadTool } from './read';
import { createWriteTool } from './write';

export const builtinToolNames = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep'
] as const;

/**
 * 创建首批内置工具集，所有工具的执行范围都被限制在 workspaceRoot 内。
 */
export function createBuiltinTools(workspaceRoot: string): ToolDefinition[] {
  return [
    createBashTool(workspaceRoot),
    createReadTool(workspaceRoot),
    createWriteTool(workspaceRoot),
    createEditTool(workspaceRoot),
    createGlobTool(workspaceRoot),
    createGrepTool(workspaceRoot)
  ];
}
