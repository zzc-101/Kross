import React from 'react';
import { Box, Text } from 'ink';

import type { ToolCallState } from './MessageLine';
import { symbols, theme } from './theme';
import { usePulse } from './usePulse';
import {
  ensureToolItems,
  formatToolTitle
} from './toolDisplay';

/**
 * 工具调用单行摘要；可展开看明细（尤其是 Read N files 聚合）。
 * 终端里用 ctrl+e 切换最近一条工具组展开/折叠。
 */
export function ToolCallCard({
  tool,
  expanded = false
}: {
  tool: ToolCallState;
  expanded?: boolean;
}) {
  const spinner = usePulse(symbols.busyFrames, 80, tool.status === 'running');
  const items = ensureToolItems(tool);
  const title = formatToolTitle({ ...tool, items });
  const statusLabel = formatToolStatus(tool.status, spinner);
  const statusColor = toolStatusColor(tool.status);
  const chevron = expanded ? '▾' : '▸';
  const canExpand = items.length > 0;

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text dimColor>{canExpand ? `${chevron} ` : '  '}</Text>
        <Text color={theme.brand}>{title}</Text>
        <Text dimColor>  </Text>
        <Text color={statusColor}>{statusLabel}</Text>
        {tool.durationMs !== undefined &&
        tool.status !== 'running' &&
        items.length === 1 ? (
          <Text dimColor> · {formatDuration(tool.durationMs)}</Text>
        ) : null}
        {canExpand && !expanded && items.length > 1 ? (
          <Text dimColor> · ctrl+e</Text>
        ) : null}
      </Box>

      {expanded
        ? items.map((item, index) => (
            <Box key={item.callId ?? `${item.path ?? 'item'}-${index}`}>
              <Text dimColor>  {symbols.systemPrefix} </Text>
              <Text dimColor>
                {item.path ?? item.preview ?? item.summary ?? tool.name}
              </Text>
              {item.status === 'failed' || item.status === 'denied' ? (
                <Text color={theme.statusError}>  {item.status}</Text>
              ) : null}
            </Box>
          ))
        : null}
    </Box>
  );
}

function formatToolStatus(
  status: ToolCallState['status'],
  spinner: string
): string {
  switch (status) {
    case 'running':
      return `${spinner}`;
    case 'completed':
      return symbols.toolOk;
    case 'failed':
      return symbols.toolFail;
    case 'denied':
      return symbols.toolFail;
    case 'awaiting':
      return symbols.toolWait;
    default:
      return status;
  }
}

function toolStatusColor(status: ToolCallState['status']): string {
  switch (status) {
    case 'running':
    case 'awaiting':
      return theme.statusBusy;
    case 'completed':
      return theme.statusReady;
    case 'failed':
    case 'denied':
      return theme.statusError;
    default:
      return theme.chip;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
