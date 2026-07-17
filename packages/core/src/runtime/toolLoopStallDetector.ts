import { createHash } from 'node:crypto';

import type { LlmMessage, LlmToolCall } from '../llm/types';
import { stableJson, toolCallsSignature } from './toolLoopShared';

export const DEFAULT_STALL_REPEAT_THRESHOLD = 2;

export type ToolLoopStallState =
  | 'progress'
  | 'repeated'
  | 'recover'
  | 'stalled';

export interface ToolLoopStallObservation {
  state: ToolLoopStallState;
  repeatedCount: number;
  fingerprint: string;
  signaturePreview: string;
}

export interface ToolLoopStallDetectorOptions {
  /** Number of unchanged repeats after the first observation before recovery. */
  repeatThreshold?: number;
}

/**
 * Detect consecutive identical tool batches that also return identical results.
 * A changed call or result is progress and resets both the repeat count and the
 * single recovery allowance.
 */
export class ToolLoopStallDetector {
  private readonly repeatThreshold: number;
  private previousFingerprint: string | undefined;
  private repeatedCount = 0;
  private recoveryIssued = false;

  constructor(options: ToolLoopStallDetectorOptions = {}) {
    this.repeatThreshold = Math.max(
      1,
      Math.floor(options.repeatThreshold ?? DEFAULT_STALL_REPEAT_THRESHOLD)
    );
  }

  observe(input: {
    calls: LlmToolCall[];
    results: LlmMessage[];
  }): ToolLoopStallObservation {
    const fingerprint = observationFingerprint(input.calls, input.results);
    const metadata = {
      fingerprint,
      signaturePreview: toolNamesPreview(input.calls)
    };

    if (fingerprint !== this.previousFingerprint) {
      this.previousFingerprint = fingerprint;
      this.repeatedCount = 0;
      this.recoveryIssued = false;
      return { state: 'progress', repeatedCount: 0, ...metadata };
    }

    this.repeatedCount += 1;
    if (this.recoveryIssued) {
      return {
        state: 'stalled',
        repeatedCount: this.repeatedCount,
        ...metadata
      };
    }
    if (this.repeatedCount >= this.repeatThreshold) {
      this.recoveryIssued = true;
      return {
        state: 'recover',
        repeatedCount: this.repeatedCount,
        ...metadata
      };
    }
    return {
      state: 'repeated',
      repeatedCount: this.repeatedCount,
      ...metadata
    };
  }
}

function observationFingerprint(
  calls: LlmToolCall[],
  results: LlmMessage[]
): string {
  const toolResults = results
    .filter((message) => message.role === 'tool')
    .map((message) => ({ name: message.name, content: message.content }));
  return createHash('sha256')
    .update(toolCallsSignature(calls))
    .update('\nresults:')
    .update(stableJson(toolResults))
    .digest('hex');
}

function toolNamesPreview(calls: LlmToolCall[]): string {
  return calls.map((call) => call.name).join(', ').slice(0, 240);
}
