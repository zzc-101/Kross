import type { LlmToolCall } from '../llm/types';
import type { ToolMetadata } from '../tools/toolGateway';
import {
  identifyVerificationCommand,
  type VerificationCommandIdentity
} from '../verification';

export const RUN_PHASES = [
  'inspect',
  'plan',
  'act',
  'verify',
  'review',
  'complete'
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export interface ToolCallPhaseClassification {
  phase: RunPhase;
  verification?: VerificationCommandIdentity;
}

const MUTATION_TOOLS = new Set([
  'Write',
  'Edit',
  'Delete',
  'Move',
  'ApplyPatch'
]);

export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === 'string' && RUN_PHASES.includes(value as RunPhase);
}

export function classifyToolCallPhase(
  call: LlmToolCall,
  metadata?: ToolMetadata,
  context: { verificationPending?: boolean } = {}
): ToolCallPhaseClassification {
  if (call.name === 'Bash' || call.name === 'ProcessStart') {
    const command = commandFromInput(call.input);
    const verification = command
      ? identifyVerificationCommand(command)
      : undefined;
    if (verification) {
      return { phase: 'verify', verification };
    }
  }

  if (call.name === 'ProcessPoll') {
    return { phase: context.verificationPending ? 'verify' : 'act' };
  }
  if (call.name === 'TodoWrite') {
    return { phase: 'plan' };
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
  if (
    type === 'plan.intent' ||
    type === 'plan.created' ||
    type === 'approval.required'
  ) {
    return 'plan';
  }
  if (type === 'conductor.execution.started') {
    return 'act';
  }
  if (type === 'conductor.review.completed' || type === 'review.completed') {
    return 'review';
  }
  return undefined;
}

function commandFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}
