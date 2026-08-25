import type { LlmToolCall } from '../llm/types';
import type { ToolMetadata } from '../tools/toolGateway';

export const RUN_PHASES = [
  'inspect',
  'prepare',
  'act',
  'review',
  'complete'
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export interface ToolCallPhaseClassification {
  phase: RunPhase;
}

const MUTATION_TOOLS = new Set([
  'Write',
  'Edit',
  'Delete',
  'Move'
]);

export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === 'string' && RUN_PHASES.includes(value as RunPhase);
}

export function classifyToolCallPhase(
  call: LlmToolCall,
  metadata?: ToolMetadata
): ToolCallPhaseClassification {
  if (call.name === 'TodoWrite') {
    return { phase: 'prepare' };
  }
  if (
    MUTATION_TOOLS.has(call.name) ||
    call.name === 'Task' ||
    metadata?.risk === 'write' ||
    metadata?.risk === 'execute'
  ) {
    return { phase: 'act' };
  }
  return { phase: 'inspect' };
}

export function phaseForLifecycleEvent(type: string): RunPhase | undefined {
  if (type === 'review.completed') {
    return 'review';
  }
  return undefined;
}
