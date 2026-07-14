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
import { createReadTool } from './read';
import { createStatTool } from './stat';
import { createWriteTool } from './write';

/**
 * Subagent tool set: basic read + edit only.
 * Excludes high-risk tools: Bash, Delete, Move, Task, MCP, network.
 */
export function createSubagentTools(workspaceRoot: string): ToolDefinition[] {
  return [
    // read
    createReadTool(workspaceRoot),
    createGlobTool(workspaceRoot),
    createGrepTool(workspaceRoot),
    createListTool(workspaceRoot),
    createStatTool(workspaceRoot),
    createGitStatusTool(workspaceRoot),
    createGitDiffTool(workspaceRoot),
    createGitLogTool(workspaceRoot),
    // edit-related (no Delete/Move)
    createEditTool(workspaceRoot),
    createWriteTool(workspaceRoot)
  ];
}

/** @deprecated Use createSubagentTools */
export const createExploreTools = createSubagentTools;
