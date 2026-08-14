/** 目录外模型的保守默认窗口。 */
export const DEFAULT_CONTEXT_WINDOW = 256_000;

export function resolveModelContextWindow(
  _model: string | undefined,
  env: Record<string, string | undefined> = process.env,
  configuredWindow?: number,
  catalogWindow?: number
): number {
  const override = parsePositiveInt(
    env.AGENT_CONTEXT_WINDOW ?? env.KROSS_CONTEXT_WINDOW
  );
  if (override !== undefined) {
    return override;
  }
  const configured = parsePositiveNumber(configuredWindow);
  if (configured !== undefined) {
    return configured;
  }

  const catalog = parsePositiveNumber(catalogWindow);
  if (catalog !== undefined) {
    return catalog;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/** 267K / 1M / 12.5K 这类紧凑计数 */
export function formatCompactCount(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n >= 1_000_000) {
    return `${formatOneDecimal(n / 1_000_000)}M`;
  }
  if (n >= 1_000) {
    return `${formatOneDecimal(n / 1_000)}K`;
  }
  return String(n);
}

/** `used/max`，例如 `12K/256K` */
export function formatContextUsage(usedTokens: number, maxTokens: number): string {
  const max = Math.max(1, Math.round(maxTokens));
  const used = Math.max(0, Math.round(usedTokens));
  return `${formatCompactCount(used)}/${formatCompactCount(max)}`;
}

function formatOneDecimal(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  if (Number.isInteger(rounded)) {
    return String(rounded);
  }
  return rounded.toFixed(1);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function parsePositiveNumber(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}
