import React from 'react';
import { Box, Text } from 'ink';

import { riskTone, symbols, theme } from './theme';
import { usePulse } from './usePulse';
import type { ToolCallState } from './MessageLine';

export function ToolCallCard({ tool }: { tool: ToolCallState }) {
  const spinner = usePulse(symbols.busyFrames, 80, tool.status === 'running');
  const riskColor = riskTone(tool.risk ?? 'write');
  const statusLabel = formatToolStatus(tool.status, spinner);
  const statusColor = toolStatusColor(tool.status);
  const inputLine = tool.inputPreview
    ? truncate(formatInputPreview(tool.inputPreview), 72)
    : undefined;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.border}>{symbols.boxTopLeft} </Text>
        <Text bold color={theme.brand}>
          {tool.name}
        </Text>
        {tool.risk ? (
          <Text color={riskColor}> · {tool.risk}</Text>
        ) : null}
        <Text dimColor>  </Text>
        <Text color={statusColor}>{statusLabel}</Text>
        {tool.durationMs !== undefined && tool.status !== 'running' ? (
          <Text dimColor> · {formatDuration(tool.durationMs)}</Text>
        ) : null}
      </Box>

      {inputLine ? (
        <Box>
          <Text color={theme.border}>{symbols.boxVertical} </Text>
          <Text dimColor>{inputLine}</Text>
        </Box>
      ) : null}

      {tool.summary && tool.status !== 'running' ? (
        <Box>
          <Text color={theme.border}>{symbols.boxVertical} </Text>
          <Text>{truncate(tool.summary, 96)}</Text>
        </Box>
      ) : null}

      <Text color={theme.border}>
        {symbols.boxBottomLeft}
        {symbols.boxHorizontal.repeat(28)}
      </Text>
    </Box>
  );
}

function formatToolStatus(
  status: ToolCallState['status'],
  spinner: string
): string {
  switch (status) {
    case 'running':
      return `${spinner} running`;
    case 'completed':
      return `${symbols.toolOk} done`;
    case 'failed':
      return `${symbols.toolFail} failed`;
    case 'denied':
      return `${symbols.toolFail} denied`;
    case 'awaiting':
      return `${symbols.toolWait} awaiting`;
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

function formatInputPreview(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.command === 'string') {
        return `$ ${record.command}`;
      }
      if (typeof record.path === 'string') {
        const extra =
          typeof record.content === 'string'
            ? ` (${record.content.length} chars)`
            : typeof record.old_string === 'string'
              ? ' patch'
              : '';
        return `${record.path}${extra}`;
      }
      if (typeof record.pattern === 'string') {
        const path = typeof record.path === 'string' ? ` in ${record.path}` : '';
        return `/${record.pattern}/${path}`;
      }
      if (typeof record.glob === 'string') {
        return record.glob;
      }
    }
  } catch {
    // keep raw
  }
  return raw;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= max) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(1, max - 1))}…`;
}
