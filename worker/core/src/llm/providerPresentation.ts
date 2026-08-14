import type { LlmCapabilities } from './providerCapabilities';
import type { LlmCallMetrics } from './providerObservability';

export function formatLlmCapabilities(
  capabilities: LlmCapabilities | undefined
): string {
  if (!capabilities) return 'capabilities: unknown';
  return [
    `tools=${yesNo(capabilities.toolCalling)}`,
    `thinking=${yesNo(capabilities.thinking)}`,
    `cache=${yesNo(capabilities.promptCaching)}`,
    `structured=${yesNo(capabilities.structuredOutput)}`,
    `vision=${yesNo(capabilities.multimodalRead)}`
  ].join(' · ');
}

export function formatLlmCallMetrics(
  metrics: LlmCallMetrics | undefined
): string {
  if (!metrics) return 'last call: none';
  const usage = metrics.usage;
  const parts = [
    `${metrics.status}`,
    `${metrics.durationMs}ms`,
    usage?.totalTokens !== undefined
      ? `${usage.totalTokens.toLocaleString()} tokens`
      : undefined,
    usage?.cacheReadTokens !== undefined
      ? `cache-read=${usage.cacheReadTokens.toLocaleString()}`
      : undefined,
    usage?.cacheWriteTokens !== undefined
      ? `cache-write=${usage.cacheWriteTokens.toLocaleString()}`
      : undefined,
    usage?.estimatedCostUsd !== undefined
      ? formatUsd(usage.estimatedCostUsd)
      : 'cost=unknown',
    metrics.errorCategory
      ? `error=${metrics.errorCategory}`
      : undefined
  ].filter((part): part is string => part !== undefined);
  return parts.join(' · ');
}

export function formatLlmCallMetricsCompact(
  metrics: LlmCallMetrics | undefined
): string | undefined {
  if (!metrics) return undefined;
  const usage = metrics.usage;
  return [
    usage?.totalTokens !== undefined
      ? `${compactNumber(usage.totalTokens)} tok`
      : undefined,
    `${metrics.durationMs}ms`,
    usage?.cacheReadTokens
      ? `${compactNumber(usage.cacheReadTokens)} cached`
      : undefined,
    usage?.estimatedCostUsd !== undefined
      ? formatUsd(usage.estimatedCostUsd)
      : undefined,
    metrics.errorCategory
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

function formatUsd(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trim(value / 1_000)}K`;
  return String(value);
}

function trim(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '');
}
