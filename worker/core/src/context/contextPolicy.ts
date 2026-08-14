import { DEFAULT_CONTEXT_WINDOW } from '../llm/modelContextWindows';

export interface ContextPolicyOptions {
  contextWindow?: number;
  /** 子代理使用减半预算 */
  isSubagent?: boolean;
  preserveFullTurns?: number;
  /** 压缩后优先保留的最近原文 token；轮数仅作为手动压缩的偏好。 */
  preserveRecentTokens?: number;
  preserveToolIterations?: number;
  maxToolResultTokens?: number;
}

export interface ContextPolicy {
  contextWindow: number;
  outputReserve: number;
  inputBudget: number;
  compactThreshold: number;
  toolResultQuota: number;
  preserveFullTurns: number;
  preserveRecentTokens: number;
  preserveToolIterations: number;
  maxToolResultTokens: number;
}

/**
 * 上下文预算策略。
 * inputBudget = contextWindow - min(32K, 12.5%)
 * 压缩触发 = inputBudget * 80%
 * 工具结果配额 = inputBudget * 40%
 */
export function createContextPolicy(
  options: ContextPolicyOptions = {}
): ContextPolicy {
  const contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const outputReserve = Math.min(32_000, Math.floor(contextWindow * 0.125));
  const baseInputBudget = contextWindow - outputReserve;
  const multiplier = options.isSubagent ? 0.5 : 1;

  const inputBudget = Math.floor(baseInputBudget * multiplier);

  return {
    contextWindow,
    outputReserve,
    inputBudget,
    compactThreshold: Math.floor(inputBudget * 0.8),
    toolResultQuota: Math.floor(inputBudget * 0.4),
    preserveFullTurns: normalizeNonNegativeInt(options.preserveFullTurns, 4),
    preserveRecentTokens:
      normalizePositiveInt(options.preserveRecentTokens) ??
      Math.max(256, Math.min(20_000, Math.floor(inputBudget * 0.1))),
    preserveToolIterations: normalizeNonNegativeInt(
      options.preserveToolIterations,
      2
    ),
    maxToolResultTokens:
      normalizePositiveInt(options.maxToolResultTokens) ?? 2_000
  };
}

function normalizeNonNegativeInt(
  value: number | undefined,
  fallback: number
): number {
  return Number.isFinite(value) && value !== undefined && value >= 0
    ? Math.floor(value)
    : fallback;
}

function normalizePositiveInt(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : undefined;
}
