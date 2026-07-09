import React from 'react';
import { Box, Text, useStdout } from 'ink';

import {
  formatStatusLabel,
  makeDivider,
  statusTone,
  symbols,
  theme,
  type UiStatus
} from './theme';
import { usePulse } from './usePulse';

export interface HeaderBarProps {
  projectName: string;
  mode: string;
  status: UiStatus;
  queueLength: number;
  permissionMode: string;
  runtimeError?: string;
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
  projectName,
  mode,
  status,
  queueLength,
  permissionMode,
  runtimeError
}: HeaderBarProps) {
  const { stdout } = useStdout();
  const busy = status !== 'ready';
  const pulse = usePulse(symbols.pulseDots, 480, busy);
  const tone = statusTone(status);
  const statusLabel = formatStatusLabel(status);
  const dot = status === 'ready' ? symbols.readyDot : pulse;
  const columns = stdout?.columns;

  return (
    <Box flexDirection="column" marginBottom={1} width="100%">
      <Box justifyContent="space-between" width="100%">
        <Box>
          <Text color={theme.brand} bold>
            {symbols.brandMark}
          </Text>
          <Text dimColor> · {projectName}</Text>
        </Box>
        <Box>
          <Text color={tone}>
            {dot} {statusLabel}
          </Text>
          <StatusChip label={mode} dim />
          <StatusChip label={`perm: ${permissionMode}`} dim />
          {queueLength > 0 ? (
            <StatusChip label={`队列：${queueLength}`} color={theme.statusBusy} />
          ) : null}
        </Box>
      </Box>
      <Text dimColor>{makeDivider(columns ? columns - 4 : undefined)}</Text>
      {runtimeError ? (
        <Box marginTop={0}>
          <Text color={theme.statusError}>
            ⚠ 模型配置加载失败：{runtimeError}
          </Text>
          <Text dimColor> · 已回退本地运行时</Text>
        </Box>
      ) : null}
    </Box>
  );
}
