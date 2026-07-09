import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

import { symbols, theme } from './theme';

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled = false
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
}) {
  if (disabled) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.prompt}>{symbols.prompt} </Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      </Box>
      <HelpHint />
    </Box>
  );
}

export function HelpHint() {
  return (
    <Box marginTop={0}>
      <Text dimColor>/help  /context  /mode  /perm  ·  shift+tab 切换权限</Text>
    </Box>
  );
}

export function SessionTip() {
  return (
    <Box marginBottom={1}>
      <Text dimColor>tip · 用自然语言描述任务；输入 / 可查看命令提示。</Text>
    </Box>
  );
}
