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
