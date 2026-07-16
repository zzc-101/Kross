import type { ToolDefinition } from '../toolGateway';
import { createEditTool } from './edit';
import {
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool
} from './git';
import { createGlobTool } from './glob';
import { createGrepTool } from './grep';
import { createListTool } from './list';
import { createRgTool } from './rg';
import { createReadTool } from './read';
import { createStatTool } from './stat';
import { createWriteTool } from './write';
import type { MutationService } from '../../mutations/mutationService';
import { createApplyPatchTool } from './applyPatch';

/**
 * Subagent tool set: basic read + edit only.
 * Excludes high-risk tools: Bash, Delete, Move, Task, MCP, network.
 */
export function createSubagentTools(
  workspaceRoot: string,
  mutations?: MutationService
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    // read
    createReadTool(workspaceRoot),
    createGlobTool(workspaceRoot),
    createGrepTool(workspaceRoot),
    createRgTool(workspaceRoot),
    createListTool(workspaceRoot),
    createStatTool(workspaceRoot),
    createGitStatusTool(workspaceRoot),
    createGitDiffTool(workspaceRoot),
    createGitLogTool(workspaceRoot),
    // edit-related (no Delete/Move)
    createEditTool(workspaceRoot, mutations),
    createWriteTool(workspaceRoot, mutations)
  ];
  if (mutations) tools.push(createApplyPatchTool(workspaceRoot, mutations));
  return tools;
}

/** @deprecated Use createSubagentTools */
export const createExploreTools = createSubagentTools;
