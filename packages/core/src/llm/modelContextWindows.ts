/**
 * 按模型名推断上下文窗口（token）。
 * 可用 AGENT_CONTEXT_WINDOW 覆盖；未知模型默认 128K。
 */

const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 常见模型关键字 → 窗口大小（先匹配更具体的） */
const MODEL_WINDOW_RULES: Array<{ match: RegExp; tokens: number }> = [
  { match: /gemini.*(-|_)?(2\.5|2\.0|1\.5).*pro|gemini-2\.5-pro/i, tokens: 1_000_000 },
  { match: /gemini.*flash|gemini-2\.0-flash/i, tokens: 1_000_000 },
  { match: /claude.*(opus|sonnet|haiku).*4|claude-sonnet-4|claude-opus-4/i, tokens: 200_000 },
  { match: /claude-3-7|claude-3\.7|claude-3-5|claude-3\.5/i, tokens: 200_000 },
  { match: /claude-3-opus|claude-3-sonnet|claude-3-haiku/i, tokens: 200_000 },
  { match: /gpt-4\.1|gpt-4o|o3|o4-mini|o1/i, tokens: 128_000 },
  { match: /gpt-4-turbo|gpt-4-1106|gpt-4-0125/i, tokens: 128_000 },
  { match: /gpt-3\.5/i, tokens: 16_000 },
  { match: /glm-5|glm-4\.5|glm-4-plus|glm-4/i, tokens: 128_000 },
  { match: /deepseek|qwen|kimi|moonshot/i, tokens: 128_000 }
];

export function resolveModelContextWindow(
  model: string | undefined,
  env: Record<string, string | undefined> = process.env
): number {
  const override = parsePositiveInt(
    env.AGENT_CONTEXT_WINDOW ?? env.KROSS_CONTEXT_WINDOW
  );
  if (override !== undefined) {
    return override;
  }

  const name = model?.trim() ?? '';
  if (!name || name === 'no model') {
    return DEFAULT_CONTEXT_WINDOW;
  }

  for (const rule of MODEL_WINDOW_RULES) {
    if (rule.match.test(name)) {
      return rule.tokens;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 字符 → token 粗估。当前 ContextManager 按字符预算，显示层换算为 token 风格。
 * 中英混合约 2–4 字符/token，取 4 偏保守（显示用量略偏低可接受）。
 */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) {
    return 0;
  }
  return Math.ceil(chars / 4);
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

/** `used/max`，例如 `12K/128K` */
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
