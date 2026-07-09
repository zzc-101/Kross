import React from 'react';
import { Box, Text } from 'ink';

import { theme } from './theme';

const LOGO = [
  '    ╱╲    ',
  '   ╱  ╲   ',
  '  ╱──K─╲  ',
  '  ╲    ╱  ',
  '   ╲  ╱   ',
  '    ╲╱    '
] as const;

export interface WelcomeAction {
  label: string;
  shortcut: string;
}

export interface WelcomeHomeProps {
  version?: string;
  modelLabel?: string;
  headline?: string;
  subtitle?: string;
  notice?: string;
  actions?: WelcomeAction[];
  tip?: string;
  width?: number;
}

const defaultActions: WelcomeAction[] = [
  { label: 'Describe a task to start', shortcut: '↵' },
  { label: 'Help', shortcut: '/help' },
  { label: 'Switch agent mode', shortcut: '/mode' },
  { label: 'Toggle permission', shortcut: 'shift+tab' },
  { label: 'Expand thinking', shortcut: 'ctrl+o' },
  { label: 'Expand tool details', shortcut: 'ctrl+e' }
];

/**
 * 新会话首页卡片（路径由外层顶栏统一渲染，这里不再重复）。
 */
export function WelcomeHome({
  version = '0.1.0',
  modelLabel,
  headline = 'Local agent runtime',
  subtitle = 'Plan, call tools, and iterate in your workspace.',
  notice,
  actions = defaultActions,
  tip = 'Press shift+tab to cycle permission mode.',
  width = 72
}: WelcomeHomeProps) {
  const cardWidth = Math.max(48, Math.min(width, 88));

  return (
    <Box flexDirection="column" alignItems="center" width={width}>
      <Box
        borderStyle="round"
        borderColor={theme.border}
        paddingX={2}
        paddingY={1}
        width={cardWidth}
        flexDirection="row"
      >
        <Box flexDirection="column" marginRight={2}>
          {LOGO.map((line) => (
            <Text key={line} color={theme.brandMuted}>
              {line}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" flexGrow={1}>
          <Box>
            <Text bold color={theme.brand}>
              Kross
            </Text>
            <Text dimColor>  {version}</Text>
          </Box>

          <Box marginTop={1}>
            <Text color={theme.accent} bold>
              {headline}
            </Text>
          </Box>
          <Text dimColor>{subtitle}</Text>

          {modelLabel ? (
            <Box marginTop={0}>
              <Text dimColor>model </Text>
              <Text color={theme.brandSoft}>{modelLabel}</Text>
            </Box>
          ) : null}

          {notice ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.statusWarn}>{notice}</Text>
            </Box>
          ) : null}

          <Box marginTop={1} flexDirection="column">
            {actions.map((action) => (
              <Box key={action.label}>
                <Text>{action.label.padEnd(28)}</Text>
                <Text dimColor>{action.shortcut}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>

      {tip ? (
        <Box marginTop={2} width={cardWidth}>
          <Text dimColor>Tip: {tip}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function formatCwdLabel(cwd: string, home = process.env.HOME): string {
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}` || '~';
  }
  return cwd;
}
