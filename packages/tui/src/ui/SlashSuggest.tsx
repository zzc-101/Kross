import React from 'react';
import { Box, Text } from 'ink';

import { symbols, theme } from './theme';
import type { SlashCommand } from './slashCommands';

export function SlashSuggest({
  commands,
  selectedIndex
}: {
  commands: SlashCommand[];
  selectedIndex: number;
}) {
  if (commands.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>commands</Text>
      {commands.map((command, index) => {
        const selected = index === selectedIndex;
        const label = (command.usage ?? command.name).padEnd(28);
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
