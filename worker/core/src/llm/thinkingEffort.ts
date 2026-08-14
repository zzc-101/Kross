import { z } from 'zod';

/** Unified thinking / reasoning effort (pi-ai SimpleStreamOptions.reasoning + off). */
export const thinkingEffortSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]);

export type ThinkingEffort = z.infer<typeof thinkingEffortSchema>;

export const THINKING_EFFORT_LEVELS: readonly ThinkingEffort[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
];

export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high';

export function isThinkingEffort(value: string): value is ThinkingEffort {
  return (THINKING_EFFORT_LEVELS as readonly string[]).includes(value);
}

export function parseThinkingEffort(
  value: string | undefined
): ThinkingEffort | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  // Common aliases
  if (trimmed === 'none' || trimmed === 'disable' || trimmed === 'disabled') {
    return 'off';
  }
  if (trimmed === 'max' || trimmed === 'maximum') {
    return 'xhigh';
  }
  if (isThinkingEffort(trimmed)) {
    return trimmed;
  }
  return undefined;
}

export function cycleThinkingEffort(current: ThinkingEffort): ThinkingEffort {
  const index = THINKING_EFFORT_LEVELS.indexOf(current);
  const next = index < 0 ? 0 : (index + 1) % THINKING_EFFORT_LEVELS.length;
  return THINKING_EFFORT_LEVELS[next] ?? DEFAULT_THINKING_EFFORT;
}

/** Footer / status: `model (medium)` — no provider prefix. */
export function formatModelEffortLabel(
  model: string | undefined,
  effort: ThinkingEffort = DEFAULT_THINKING_EFFORT
): string {
  const name = model?.trim();
  if (!name) {
    return 'no model';
  }
  return `${name} (${effort})`;
}
