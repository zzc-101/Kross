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
import { createRgTool } from './rg';
import { createMoveTool } from './move';
import { createReadTool } from './read';
import { createStatTool } from './stat';
import {
  createDefaultSubagentRunner,
  createTaskTool,
  type CreateTaskToolOptions
} from './task';
import { createSetModeTool, type CreateSetModeToolOptions } from './setMode';
import { createTodoReadTool, createTodoWriteTool } from './todo';
import { createWriteTool } from './write';
import type { TodoStore } from '../../todo/todoStore';

export { createExploreTools, createSubagentTools } from './exploreTools';
export { createRgTool, buildRgArgs, resolveRgBinary } from './rg';
export {
  createDefaultSubagentRunner,
  createTaskTool,
  type CreateTaskToolOptions
} from './task';
export { createSetModeTool, type CreateSetModeToolOptions } from './setMode';
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
  'Rg',
  'List',
  'Stat',
  'GitStatus',
  'GitDiff',
  'GitLog',
  'Task',
  'TodoWrite',
  'TodoRead',
  'SetMode'
] as const;

export interface CreateBuiltinToolsOptions {
  /** Include Task (subagent) tool. Default true when runSubagent provided, else false. */
  includeTask?: boolean;
  parentDepth?: number;
  runSubagent?: CreateTaskToolOptions['run'];
  /** Resolve project-registry repoId → absolute path (multi-repo Task). */
  resolveRepoPath?: CreateTaskToolOptions['resolveRepoPath'];
  /** Session todo store; when set, registers TodoWrite + TodoRead. */
  todoStore?: TodoStore;
  /** When set, registers SetMode for conversational mode switching. */
  setMode?: CreateSetModeToolOptions;
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
    createRgTool(workspaceRoot),
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
        run: options.runSubagent,
        resolveRepoPath: options.resolveRepoPath
      })
    );
  }

  if (options.todoStore) {
    tools.push(
      createTodoWriteTool(options.todoStore),
      createTodoReadTool(options.todoStore)
    );
  }

  if (options.setMode) {
    tools.push(createSetModeTool(options.setMode));
  }

  return tools;
}
