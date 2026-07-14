import type { ToolDefinition } from '../toolGateway';
import { createBashTool } from './bash';
import { createDeleteTool } from './delete';
import { createEditTool } from './edit';
import { createExploreTools } from './exploreTools';
import {
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool
} from './git';
import { createGlobTool } from './glob';
import { createGrepTool } from './grep';
import { createListTool } from './list';
import { createMoveTool } from './move';
import { createReadTool } from './read';
import { createStatTool } from './stat';
import {
  createDefaultSubagentRunner,
  createTaskTool,
  type CreateTaskToolOptions
} from './task';
import { createTodoReadTool, createTodoWriteTool } from './todo';
import { createWriteTool } from './write';
import type { TodoStore } from '../../todo/todoStore';

export { createExploreTools, createSubagentTools } from './exploreTools';
export {
  createDefaultSubagentRunner,
  createTaskTool,
  type CreateTaskToolOptions
} from './task';
export { createTodoReadTool, createTodoWriteTool } from './todo';

export const builtinToolNames = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Delete',
  'Move',
  'Glob',
  'Grep',
  'List',
  'Stat',
  'GitStatus',
  'GitDiff',
  'GitLog',
  'Task',
  'TodoWrite',
  'TodoRead'
] as const;

export interface CreateBuiltinToolsOptions {
  /** Include Task (subagent) tool. Default true when runSubagent provided, else false. */
  includeTask?: boolean;
  parentDepth?: number;
  runSubagent?: CreateTaskToolOptions['run'];
  /** Session todo store; when set, registers TodoWrite + TodoRead. */
  todoStore?: TodoStore;
}

/**
 * 创建首批内置工具集。文件类工具会校验 workspace 边界；
 * Bash 只保证启动 cwd 位于 workspace 内，命令能力仍由审批策略约束。
 * 传入 runSubagent 时注册 Task（explore 子代理）。
 */
export function createBuiltinTools(
  workspaceRoot: string,
  options: CreateBuiltinToolsOptions = {}
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createBashTool(workspaceRoot),
    createReadTool(workspaceRoot),
    createWriteTool(workspaceRoot),
    createEditTool(workspaceRoot),
    createDeleteTool(workspaceRoot),
    createMoveTool(workspaceRoot),
    createGlobTool(workspaceRoot),
    createGrepTool(workspaceRoot),
    createListTool(workspaceRoot),
    createStatTool(workspaceRoot),
    createGitStatusTool(workspaceRoot),
    createGitDiffTool(workspaceRoot),
    createGitLogTool(workspaceRoot)
  ];

  const includeTask =
    options.includeTask ?? options.runSubagent !== undefined;
  if (includeTask && options.runSubagent) {
    tools.push(
      createTaskTool({
        parentDepth: options.parentDepth ?? 0,
        run: options.runSubagent
      })
    );
  }

  if (options.todoStore) {
    tools.push(
      createTodoWriteTool(options.todoStore),
      createTodoReadTool(options.todoStore)
    );
  }

  return tools;
}
