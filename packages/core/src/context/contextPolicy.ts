import { DEFAULT_CONTEXT_WINDOW } from '../llm/modelContextWindows';

export interface ContextPolicyOptions {
  contextWindow?: number;
  /** 子代理使用减半预算 */
  isSubagent?: boolean;
  preserveFullTurns?: number;
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
    preserveFullTurns: options.preserveFullTurns ?? 4,
    preserveToolIterations: options.preserveToolIterations ?? 2,
    maxToolResultTokens: options.maxToolResultTokens ?? 2_000
  };
}
