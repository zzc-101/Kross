import React from 'react';
import { Box, Text } from 'ink';
import { t } from '@kross/core';

import { symbols, theme } from './theme';
import type { SlashCommand } from './slashCommands';

function categoryLabel(category: SlashCommand['category']): string {
  switch (category) {
    case 'common':
      return t('slash.category.common');
    case 'inspection':
      return t('slash.category.inspection');
    case 'settings':
      return t('slash.category.settings');
    case 'contextual':
      return t('slash.category.contextual');
    default:
      return category;
  }
}

export function SlashSuggest({
  commands,
  selectedIndex = 0,
  hiddenCount = 0,
  width = 80
}: {
  commands: SlashCommand[];
  selectedIndex?: number;
  hiddenCount?: number;
  width?: number;
}) {
  if (commands.length === 0) {
    return null;
  }

  const maxLabel = resolveSlashUsageWidth(width);
  let previousCategory: SlashCommand['category'] | undefined;

  return (
    <Box flexDirection="column" marginBottom={1} width={width}>
      <Text dimColor>{t('slash.suggest.title')}</Text>
      {commands.map((command, index) => {
        const selected = index === selectedIndex;
        const showCategory = command.category !== previousCategory;
        previousCategory = command.category;
        const usage = command.usage ?? command.name;
        // 截断过长的 usage，保持列对齐
        const label =
          usage.length > maxLabel
            ? `${usage.slice(0, maxLabel - 1)}…`
            : usage.padEnd(maxLabel);
        return (
          <React.Fragment key={command.name}>
            {showCategory ? (
              <Text dimColor>{categoryLabel(command.category)}</Text>
            ) : null}
            <Box>
              <Text color={selected ? theme.selection : undefined} bold={selected}>
                {selected ? `${symbols.suggestPointer} ` : '  '}
                {label}
              </Text>
              <Box flexShrink={1} overflowX="hidden">
                <Text
                  wrap="truncate"
                  dimColor={!selected}
                  color={selected ? theme.brandSoft : undefined}
                >
                  {command.description}
                </Text>
              </Box>
            </Box>
          </React.Fragment>
        );
      })}
      <Text dimColor>{t('slash.suggest.hotkeys')}</Text>
      {hiddenCount > 0 ? (
        <Text dimColor>{t('slash.suggest.more', { count: hiddenCount })}</Text>
      ) : null}
    </Box>
  );
}

export function resolveSlashSuggestHeight(
  commands: SlashCommand[],
  hiddenCount = 0
): number {
  const categoryCount = new Set(commands.map((command) => command.category)).size;
  return commands.length + categoryCount + 3 + (hiddenCount > 0 ? 1 : 0);
}

export function resolveSlashUsageWidth(width: number): number {
  return Math.max(8, Math.min(30, Math.floor(width * 0.38)));
}
