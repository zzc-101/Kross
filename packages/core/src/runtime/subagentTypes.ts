import type { SubagentResult } from '../domain';

export type SubagentMode = 'explore' | 'general';

export interface SubagentRunRequest {
  prompt: string;
  mode?: SubagentMode;
  /** 短标题（Task description），供 TUI 单行展示 */
  title?: string;
  parentRunId: string;
  parentDepth?: number;
  signal?: AbortSignal;
  /**
   * Override tools workspace root for this spawn (/add-dir root).
   * Must be under deps.allowedWorkspaceRoots when that list is set.
   */
  workspaceRoot?: string;
  /** Optional label for trace / UI (e.g. /add-dir id). */
  repoId?: string;
  /**
   * Prefer workerLlmClient (经济/快速模型) when available — used by conductor.
   */
  preferWorkerModel?: boolean;
}

export interface SubagentRunOutcome {
  result: SubagentResult;
  subRunId: string;
  mode: SubagentMode;
  modeForcedToExplore: boolean;
}

export type SubagentRunner = (
  request: SubagentRunRequest
) => Promise<SubagentRunOutcome>;
