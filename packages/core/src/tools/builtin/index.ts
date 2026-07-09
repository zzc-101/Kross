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
 * 创建首批内置工具集。文件类工具会校验 workspace 边界；
 * Bash 只保证启动 cwd 位于 workspace 内，命令能力仍由审批策略约束。
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
