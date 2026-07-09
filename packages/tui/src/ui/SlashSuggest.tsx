import React from 'react';
import { Box, Text } from 'ink';

import { symbols, theme } from './theme';
import type { SlashCommand } from './slashCommands';

export function SlashSuggest({
  commands,
  selectedIndex = 0
}: {
  commands: SlashCommand[];
  selectedIndex?: number;
}) {
  if (commands.length === 0) {
    return null;
  }

  const maxLabel = 30;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>commands</Text>
      {commands.map((command, index) => {
        const selected = index === selectedIndex;
        const usage = command.usage ?? command.name;
        // 截断过长的 usage，保持列对齐
        const label =
          usage.length > maxLabel
            ? `${usage.slice(0, maxLabel - 1)}…`
            : usage.padEnd(maxLabel);
        return (
          <Box key={command.name}>
            <Text color={selected ? theme.selection : undefined} bold={selected}>
              {selected ? `${symbols.suggestPointer} ` : '  '}
              {label}
            </Text>
            <Text
              dimColor={!selected}
              color={selected ? theme.brandSoft : undefined}
            >
              {command.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
