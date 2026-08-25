import type { ToolDefinition } from '../toolGateway';
import { createDeleteTool } from './delete';
import { createEditTool } from './edit';
import { createExploreTools } from './exploreTools';
import { createGlobTool } from './glob';
import { createGrepTool } from './grep';
import { createListTool } from './list';
import { createRgTool } from './rg';
import { createMoveTool } from './move';
import { createReadTool } from './read';
import { createReadSkillTool } from './readSkill';
import { createStatTool } from './stat';
import { createTaskTool, type CreateTaskToolOptions } from './task';
import { createTodoReadTool, createTodoWriteTool } from './todo';
import { createWriteTool } from './write';
import type { TodoStore } from '../../todo/todoStore';
import type { SkillRegistry } from '../../skills/skillRegistry';
import type {
  MutationCoordinator,
  MutationService
} from '../../mutations/mutationService';

export { createExploreTools, createSubagentTools } from './exploreTools';
export { createRgTool, buildRgArgs, resolveRgBinary } from './rg';
export { createTaskTool, type CreateTaskToolOptions } from './task';
export { createDefaultSubagentRunner } from '../../runtime/subagentRunner';
export { createTodoReadTool, createTodoWriteTool } from './todo';
export { createReadSkillTool } from './readSkill';
export { createApplyPatchTool } from './applyPatch';
export { createProcessTools } from './processTools';

export const saasToolNames = [
  'Read',
  'ReadSkill',
  'Write',
  'Edit',
  'Delete',
  'Move',
  'Glob',
  'Grep',
  'Rg',
  'List',
  'Stat',
  'Task',
  'TodoWrite',
  'TodoRead'
] as const;

export interface CreateSaasToolsOptions {
  /** Include Task (subagent) tool. Default true when runSubagent provided, else false. */
  includeTask?: boolean;
  parentDepth?: number;
  runSubagent?: CreateTaskToolOptions['run'];
  /** Resolve project-registry repoId → absolute path (multi-repo Task). */
  resolveRepoPath?: CreateTaskToolOptions['resolveRepoPath'];
  /** Session todo store; when set, registers TodoWrite + TodoRead. */
  todoStore?: TodoStore;
  /** Dynamic personal/project Skill registry; when set, registers ReadSkill. */
  skillRegistry?: SkillRegistry;
  /** Durable pre/post image journal for all file mutation tools. */
  mutationService?: MutationService;
  /** Optional coordinator for additional explicitly authorized workspaces. */
  mutationCoordinator?: MutationCoordinator;
}

/** Create the default SaaS Work Agent tool set. */
export function createSaasTools(
  workspaceRoot: string,
  options: CreateSaasToolsOptions = {}
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createReadTool(workspaceRoot),
    createWriteTool(
      workspaceRoot,
      options.mutationService,
      options.mutationCoordinator
    ),
    createEditTool(
      workspaceRoot,
      options.mutationService,
      options.mutationCoordinator
    ),
    createDeleteTool(
      workspaceRoot,
      options.mutationService,
      options.mutationCoordinator
    ),
    createMoveTool(
      workspaceRoot,
      options.mutationService,
      options.mutationCoordinator
    ),
    createGlobTool(workspaceRoot),
    createGrepTool(workspaceRoot),
    createRgTool(workspaceRoot),
    createListTool(workspaceRoot),
    createStatTool(workspaceRoot)
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

  if (options.skillRegistry) {
    tools.push(createReadSkillTool(options.skillRegistry));
  }

  return tools;
}
