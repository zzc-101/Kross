import type { LlmToolCall } from '../llm/types';

export const DEFAULT_PROGRESS_WARNING_THRESHOLD = 3;
export const DEFAULT_PROGRESS_STALL_THRESHOLD = 6;

export type RunProgressState = 'progress' | 'idle' | 'warn' | 'stalled';

export interface RunProgressObservation {
  state: RunProgressState;
  consecutiveNoProgress: number;
  reason: string;
  toolNames: string[];
}

const READ_ONLY_TOOLS = new Set([
  'Read',
  'Rg',
  'List',
  'Glob',
  'Grep',
  'Stat',
  'TodoRead'
]);

/**
 * Detect semantic non-progress: changing read/search commands must not reset the
 * counter merely because their exact arguments or output differ.
 */
export class RunProgressMonitor {
  private consecutiveNoProgress = 0;

  constructor(
    private readonly warningThreshold = DEFAULT_PROGRESS_WARNING_THRESHOLD,
    private readonly stallThreshold = DEFAULT_PROGRESS_STALL_THRESHOLD
  ) {}

  observe(calls: LlmToolCall[]): RunProgressObservation {
    const toolNames = calls.map((call) => call.name);
    const meaningful = calls.some(isMeaningfulAction);
    if (meaningful) {
      this.consecutiveNoProgress = 0;
      return {
        state: 'progress',
        consecutiveNoProgress: 0,
        reason: 'a state-changing or delegated action was observed',
        toolNames
      };
    }

    this.consecutiveNoProgress += 1;
    const state = this.consecutiveNoProgress >= this.stallThreshold
      ? 'stalled'
      : this.consecutiveNoProgress === this.warningThreshold
        ? 'warn'
        : 'idle';
    return {
      state,
      consecutiveNoProgress: this.consecutiveNoProgress,
      reason: 'only inspection/search actions observed',
      toolNames
    };
  }
}

function isMeaningfulAction(call: LlmToolCall): boolean {
  return !READ_ONLY_TOOLS.has(call.name);
}
