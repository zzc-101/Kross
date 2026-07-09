import React from 'react';
import { Box, Text } from 'ink';

import { theme } from './theme';
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
      {commands.map((command, index) => {
        const selected = index === selectedIndex;
        return (
          <Box key={command.name}>
            <Text color={selected ? theme.brand : undefined} bold={selected}>
              {selected ? '❯ ' : '  '}
              {(command.usage ?? command.name).padEnd(28)}
            </Text>
            <Text dimColor={selected ? false : true} color={selected ? theme.brand : undefined}>
              {command.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
