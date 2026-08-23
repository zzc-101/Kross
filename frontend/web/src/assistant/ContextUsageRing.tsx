export function ContextUsageRing({
  usedTokens,
  contextWindow
}: {
  usedTokens: number;
  contextWindow: number;
}) {
  const safeWindow = Math.max(1, contextWindow);
  const ratio = Math.min(Math.max(usedTokens / safeWindow, 0), 1);
  const percentage = Math.round(ratio * 100);
  const tone = ratio >= 0.95 ? ' critical' : ratio >= 0.8 ? ' warning' : '';
  const summary = `${compactTokenCount(usedTokens)} / ${compactTokenCount(contextWindow)} · ${percentage}%`;

  return (
    <span
      className={`context-usage-ring${tone}`}
      tabIndex={0}
      role="img"
      aria-label={`当前会话上下文已使用 ${percentage}%，${usedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} Token`}
    >
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className="context-usage-track" cx="18" cy="18" r="15" pathLength="100" />
        <circle
          className="context-usage-progress"
          cx="18"
          cy="18"
          r="15"
          pathLength="100"
          strokeDasharray={`${percentage} 100`}
        />
      </svg>
      <span className="context-usage-value" aria-hidden="true">{percentage}</span>
      <span className="context-usage-tooltip" role="tooltip">
        <strong>上下文用量</strong>
        <span>{summary}</span>
      </span>
    </span>
  );
}

export function compactTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return Math.max(0, Math.round(value)).toString();
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
}
