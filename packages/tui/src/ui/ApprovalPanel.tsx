import React from 'react';
import { Box, Text, useStdout } from 'ink';

import type { PendingToolApproval } from '@kross/core';

import { riskTone, symbols, theme } from './theme';
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
  const width = Math.max(30, Math.min((stdout?.columns ?? 48) - 4, 72));
  const innerWidth = width - 4; // border + space + content + space + border
  const hRule = symbols.boxHorizontal.repeat(innerWidth);
  const riskColor = riskTone(approval.risk);

  /** 带左右边框的内容行 */
  const Row = ({ children }: { children: React.ReactNode }) => (
    <Box>
      <Text color={theme.border}>{symbols.boxVertical} </Text>
      <Box flexGrow={1} flexShrink={1} overflowX="hidden">
        {children}
      </Box>
      <Text color={theme.border}> {symbols.boxVertical}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} width={width}>
      <Text color={theme.statusWarn}>
        {symbols.boxTopLeft}
        {hRule}
        {symbols.boxTopRight}
      </Text>

      <Row>
        <Text color={theme.statusWarn} bold>
          需要确认工具调用
        </Text>
      </Row>

      <Row>
        <Text dimColor>tool  </Text>
        <Text bold>{approval.toolName}</Text>
        <Text dimColor>  ·  risk </Text>
        <Text color={riskColor} bold>
          {approval.risk}
        </Text>
      </Row>

      <Row>
        <Text dimColor>input </Text>
        <Text>{truncate(approval.inputPreview ?? '', innerWidth - 6)}</Text>
      </Row>

      {approval.reason ? (
        <Row>
          <Text dimColor>why   </Text>
          <Text>{truncate(approval.reason, innerWidth - 6)}</Text>
        </Row>
      ) : null}

      <Row>
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
      </Row>

      <Text color={theme.border}>
        {symbols.boxBottomLeft}
        {hRule}
        {symbols.boxBottomRight}
      </Text>
      <Text dimColor>{' ←/-> 切换 · Enter 确认 · a/r 快捷键'}</Text>
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
