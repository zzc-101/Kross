import React from 'react';
import { Box, Text, useStdout } from 'ink';

import type { PendingToolApproval } from '@kross/core';

import { makeDivider, riskTone, symbols, theme } from './theme';
import { usePulse } from './usePulse';

export function ApprovalPanel({
  approval,
  selection
}: {
  approval: PendingToolApproval;
  selection: 'approve' | 'reject';
}) {
  const highlight = usePulse(
    [symbols.approvePointer, symbols.approvePointerSoft],
    380,
    true
  );
  const { stdout } = useStdout();
  const width = Math.max(28, Math.min((stdout?.columns ?? 48) - 4, 72));
  const topRule = makeDivider(width - 2, symbols.boxHorizontal);
  const riskColor = riskTone(approval.risk);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text color={theme.statusWarn}>
        {symbols.boxTopLeft}
        {topRule}
        {symbols.boxTopRight}
      </Text>

      <Box>
        <Text color={theme.border}>{symbols.boxVertical} </Text>
        <Text color={theme.statusWarn} bold>
          需要确认工具调用
        </Text>
      </Box>

      <Box>
        <Text color={theme.border}>{symbols.boxVertical} </Text>
        <Text dimColor>tool  </Text>
        <Text bold>{approval.toolName}</Text>
        <Text dimColor>  ·  risk </Text>
        <Text color={riskColor} bold>
          {approval.risk}
        </Text>
      </Box>

      <Box>
        <Text color={theme.border}>{symbols.boxVertical} </Text>
        <Text dimColor>input </Text>
        <Text>{truncate(approval.inputPreview, width - 10)}</Text>
      </Box>

      {approval.reason ? (
        <Box>
          <Text color={theme.border}>{symbols.boxVertical} </Text>
          <Text dimColor>why   </Text>
          <Text>{truncate(approval.reason, width - 10)}</Text>
        </Box>
      ) : null}

      <Box>
        <Text color={theme.border}>{symbols.boxVertical} </Text>
        <Text
          color={selection === 'approve' ? theme.approve : undefined}
          bold={selection === 'approve'}
          dimColor={selection !== 'approve'}
        >
          {selection === 'approve' ? `${highlight} ` : '  '}
          Approve
        </Text>
        <Text>    </Text>
        <Text
          color={selection === 'reject' ? theme.reject : undefined}
          bold={selection === 'reject'}
          dimColor={selection !== 'reject'}
        >
          {selection === 'reject' ? `${highlight} ` : '  '}
          Reject
        </Text>
      </Box>

      <Text color={theme.border}>
        {symbols.boxBottomLeft}
        {topRule}
        {symbols.boxBottomRight}
      </Text>
      <Text dimColor>←/→ 切换 · Enter 确认 · a/r 快捷键</Text>
    </Box>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  if (max <= 1) {
    return '…';
  }
  return `${value.slice(0, max - 1)}…`;
}
