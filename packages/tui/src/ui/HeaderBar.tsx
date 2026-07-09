import React from 'react';
import { Box, Text } from 'ink';

import { formatStatusLabel, statusTone, symbols, theme, type UiStatus } from './theme';
import { usePulse } from './usePulse';

export interface HeaderBarProps {
  projectName: string;
  mode: string;
  status: UiStatus;
  queueLength: number;
  permissionMode: string;
  runtimeError?: string;
}

export function HeaderBar({
  projectName,
  mode,
  status,
  queueLength,
  permissionMode,
  runtimeError
}: HeaderBarProps) {
  const busy = status !== 'ready';
  const pulse = usePulse(symbols.pulseDots, 480, busy);
  const tone = statusTone(status);
  const statusLabel = formatStatusLabel(status);
  const dot = status === 'ready' ? symbols.readyDot : pulse;

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
          <Text dimColor> · {mode}</Text>
          <Text dimColor> · perm: {permissionMode}</Text>
          {queueLength > 0 ? <Text dimColor> · 队列：{queueLength}</Text> : null}
        </Box>
      </Box>
      <Text dimColor>{'─'.repeat(48)}</Text>
      <Text dimColor>shift+tab 切换权限模式</Text>
      {runtimeError ? (
        <Text color={theme.statusError}>
          模型配置加载失败：{runtimeError}（已回退为未配置模型的本地运行时）
        </Text>
      ) : null}
    </Box>
  );
}
