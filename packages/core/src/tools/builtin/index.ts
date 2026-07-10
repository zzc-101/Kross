import type { ToolDefinition } from '../toolGateway';
import { createBashTool } from './bash';
import { createEditTool } from './edit';
import {
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool
} from './git';
import { createGlobTool } from './glob';
import { createGrepTool } from './grep';
import { createListTool } from './list';
import { createReadTool } from './read';
import { createStatTool } from './stat';
import { createWriteTool } from './write';

export const builtinToolNames = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'List',
  'Stat',
  'GitStatus',
  'GitDiff',
  'GitLog'
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
    createGrepTool(workspaceRoot),
    createListTool(workspaceRoot),
    createStatTool(workspaceRoot),
    createGitStatusTool(workspaceRoot),
    createGitDiffTool(workspaceRoot),
    createGitLogTool(workspaceRoot)
  ];
}
