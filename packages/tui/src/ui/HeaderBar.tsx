import React from 'react';
import { Box, Text, useStdout } from 'ink';

import {
  formatModeLabel,
  formatPermissionModeLabel,
  formatStatusLabel,
  makeDivider,
  statusTone,
  theme,
  type UiStatus
} from './theme';
import { usePulse } from './usePulse';

export interface HeaderBarProps {
  /** 兼容旧用法；无 branch/cwd 时作为左侧标签 */
  projectName?: string;
  branch?: string;
  cwdLabel?: string;
  mode: string;
  status: UiStatus;
  queueLength: number;
  permissionMode: string;
  runtimeError?: string;
  /** 首页仅显示路径 + 上下文用量，不显示状态芯片 */
  compact?: boolean;
  /** 会话上下文占用，如 12K/128K */
  contextUsageLabel?: string;
  /** 0–1，用于用量颜色 */
  contextUsageRatio?: number;
}

function StatusChip({
  label,
  color,
  dim = false
}: {
  label: string;
  color?: string;
  dim?: boolean;
}) {
  return (
    <Text>
      <Text dimColor> </Text>
      <Text color={color} dimColor={dim && !color}>
        {label}
      </Text>
    </Text>
  );
}

export function HeaderBar({
  projectName = 'local',
  branch,
  cwdLabel,
  mode,
  status,
  queueLength,
  permissionMode,
  runtimeError,
  compact = false,
  contextUsageLabel,
  contextUsageRatio = 0
}: HeaderBarProps) {
  const { stdout } = useStdout();
  const busy = status !== 'ready';
  const pulse = usePulse(symbolsPulseDots, 480, busy && !compact);
  const tone = statusTone(status);
  const statusLabel = formatStatusLabel(status);
  const dot = status === 'ready' ? '●' : pulse;
  const columns = stdout?.columns;
  const locationLabel = formatLocationLabel({ branch, cwdLabel, projectName });
  const usageColor = contextUsageTone(contextUsageRatio);

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      <Box justifyContent="space-between" width="100%">
        <Text dimColor>{locationLabel}</Text>
        <Box>
          {contextUsageLabel ? (
            <Text color={usageColor}>{contextUsageLabel}</Text>
          ) : null}
          {!compact ? (
            <>
              <Text dimColor>  </Text>
              <Text color={tone}>
                {dot} {statusLabel}
              </Text>
              <StatusChip label={formatModeLabel(mode)} dim />
              <StatusChip label={formatPermissionModeLabel(permissionMode)} dim />
              {queueLength > 0 ? (
                <StatusChip label={`队列：${queueLength}`} color={theme.statusBusy} />
              ) : null}
            </>
          ) : null}
        </Box>
      </Box>
      {!compact ? (
        <Text dimColor>{makeDivider(columns ? columns - 2 : undefined)}</Text>
      ) : null}
      {runtimeError ? (
        <Box>
          <Text color={theme.statusError}>
            ⚠ 模型配置加载失败：{runtimeError}
          </Text>
          <Text dimColor> · 已回退本地运行时</Text>
        </Box>
      ) : null}
    </Box>
  );
}

const symbolsPulseDots = ['●', '○', '●', '○'] as const;

export function formatLocationLabel(input: {
  branch?: string;
  cwdLabel?: string;
  projectName?: string;
}): string {
  const parts: string[] = [];
  if (input.branch) {
    parts.push(input.branch);
  }
  if (input.cwdLabel) {
    parts.push(input.cwdLabel);
  }
  if (parts.length > 0) {
    return parts.join('  ');
  }
  return input.projectName ?? 'local';
}

export function contextUsageTone(
  ratio: number
): typeof theme.statusReady | typeof theme.statusWarn | typeof theme.statusError | typeof theme.chip {
  if (ratio >= 0.85) {
    return theme.statusError;
  }
  if (ratio >= 0.6) {
    return theme.statusWarn;
  }
  if (ratio > 0) {
    return theme.statusReady;
  }
  return theme.chip;
}
