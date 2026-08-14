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

export type FailedStrategyState = 'new' | 'rejected' | 'stalled';

/** Track repeated failed verification against the exact same workspace state. */
export class VerificationFailureLedger {
  private lastMutationIndex: number | undefined;
  private attempts = 0;

  observe(input: { lastMutationIndex: number; reason: string }): {
    state: FailedStrategyState;
    attempts: number;
    lastMutationIndex: number;
    reason: string;
  } {
    if (input.lastMutationIndex !== this.lastMutationIndex) {
      this.lastMutationIndex = input.lastMutationIndex;
      this.attempts = 1;
    } else {
      this.attempts += 1;
    }
    return {
      state: this.attempts >= 3
        ? 'stalled'
        : this.attempts === 2
          ? 'rejected'
          : 'new',
      attempts: this.attempts,
      ...input
    };
  }

  reset(): void {
    this.lastMutationIndex = undefined;
    this.attempts = 0;
  }
}

const MUTATION_TOOLS = new Set(['Write', 'Edit', 'Delete', 'Move', 'ApplyPatch']);
const VERIFICATION_COMMAND = /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check|lint|build|typecheck))\b|^(?:pytest|python\s+-m\s+pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|make\s+(?:test|check))\b/i;
const INSPECTION_COMMAND = /^(?:pwd|ls|find|fd|rg|grep|sed|cat|head|tail|wc|file|stat|which|type|git\s+(?:status|diff|log|show|branch|rev-parse))\b/i;

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
        reason: 'workspace mutation, verification, or non-inspection action observed',
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
  if (MUTATION_TOOLS.has(call.name)) return true;
  if (call.name === 'Bash' || call.name === 'ProcessStart') {
    const command = commandFromInput(call.input);
    if (!command) return true;
    const normalized = command.trim().replace(/^(?:cd\s+\S+\s*&&\s*)+/, '');
    if (VERIFICATION_COMMAND.test(normalized)) return true;
    return !INSPECTION_COMMAND.test(normalized);
  }
  return !['Read', 'Rg', 'List', 'Glob', 'TodoWrite'].includes(call.name);
}

function commandFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}
