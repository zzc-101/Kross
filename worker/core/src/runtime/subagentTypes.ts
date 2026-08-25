import type { SubagentResult } from '../domain';

export type SubagentMode = 'explore' | 'general';

export interface SubagentModelProfileSummary {
  id: string;
  name: string;
  provider: string;
  model: string;
  contextWindow?: number;
}

export interface SubagentRunRequest {
  goal: string;
  mode?: SubagentMode;
  /** Short user-facing task title. */
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
  /** Configured Kross model profile to use instead of the inherited model. */
  modelProfileId?: string;
  /**
   * Prefer workerLlmClient (经济/快速模型) when available.
   */
  preferWorkerModel?: boolean;
}

export interface SubagentRunOutcome {
  result: SubagentResult;
  subRunId: string;
  mode: SubagentMode;
  modeForcedToExplore: boolean;
  modelProfileId?: string;
  modelProfileName?: string;
  model?: string;
}

export type SubagentRunner = (
  request: SubagentRunRequest
) => Promise<SubagentRunOutcome>;
