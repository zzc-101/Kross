import React from 'react';
import { Box, Text } from 'ink';

import type { PendingToolApproval } from '@kross/core';

import { theme } from './theme';
import { usePulse } from './usePulse';

export function ApprovalPanel({
  approval,
  selection
}: {
  approval: PendingToolApproval;
  selection: 'approve' | 'reject';
}) {
  const highlight = usePulse(['▸', '▹'], 380, true);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text color={theme.statusWarn} bold>
        需要确认工具调用
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text dimColor>tool   </Text>
          {approval.toolName}
        </Text>
        <Text>
          <Text dimColor>risk   </Text>
          {approval.risk}
        </Text>
        <Text>
          <Text dimColor>input  </Text>
          {approval.inputPreview}
        </Text>
        {approval.reason ? (
          <Text>
            <Text dimColor>reason </Text>
            {approval.reason}
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color={selection === 'approve' ? theme.approve : undefined} bold={selection === 'approve'}>
          {selection === 'approve' ? `${highlight} ` : '  '}
          Approve
        </Text>
        <Text>   </Text>
        <Text color={selection === 'reject' ? theme.reject : undefined} bold={selection === 'reject'}>
          {selection === 'reject' ? `${highlight} ` : '  '}
          Reject
        </Text>
      </Box>
      <Text dimColor>←/→ 切换，Enter 确认；也可按 a/r。</Text>
    </Box>
  );
}
