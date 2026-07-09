import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import TextInput from 'ink-text-input';

import { formatPermissionFooter, type PermissionMode } from '@kross/core';

import { symbols, theme } from './theme';

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  modelLabel = 'no model',
  permissionMode = 'default'
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  modelLabel?: string;
  permissionMode?: PermissionMode;
}) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  // 外边距 paddingX=1 各 1，再留一点余量
  const width = Math.max(36, Math.min(columns - 4, 100));

  const footerLabel = useMemo(
    () => `${modelLabel} · ${formatPermissionFooter(permissionMode)}`,
    [modelLabel, permissionMode]
  );

  if (disabled) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1} width={width}>
      <Box
        borderStyle="round"
        borderColor={theme.border}
        flexDirection="column"
        paddingX={1}
        width={width}
      >
        <Box>
          <Text color={theme.prompt}>{symbols.prompt} </Text>
          <Box flexGrow={1}>
            <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
          </Box>
        </Box>
        <Box justifyContent="flex-end">
          <Text dimColor>{footerLabel}</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function HelpHint() {
  return (
    <Box marginTop={0}>
      <Text dimColor>
        /help · /context · /mode · /perm · shift+tab 权限 · ctrl+o thinking
      </Text>
    </Box>
  );
}

export function SessionTip({ visible = true }: { visible?: boolean }) {
  if (!visible) {
    return null;
  }

  return (
    <Box marginBottom={1}>
      <Text dimColor>tip · 自然语言描述任务；输入 /help 查看命令。</Text>
    </Box>
  );
}
