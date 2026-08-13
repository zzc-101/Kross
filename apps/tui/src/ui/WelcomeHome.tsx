import React from 'react';
import { Box, Text } from 'ink';
import { t } from '@kross/core';
import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';

import { theme } from './theme';

export const ASCII_WORDMARK = [
  '    __ __   ____    ____    ______   ______',
  '   / //_/  / __ \\  / __ \\  / ___/  / ___/',
  '  / ,<    / /_/ / / / / /  \\__ \\   \\__ \\',
  ' / /| |  / _, _/ / /_/ /  ___/ /  ___/ /',
  '/_/ |_| /_/ |_|  \\____/  /____/  /____/'
] as const;

const ASCII_WORDMARK_WIDTH = Math.max(
  ...ASCII_WORDMARK.map((line) => line.length)
);

export interface WelcomeAction {
  label: string;
  shortcut: string;
}

export interface WelcomeRecentSession {
  id: string;
  title: string;
  updatedAt: string;
}

export interface WelcomeHomeProps {
  version?: string;
  modelLabel?: string;
  headline?: string;
  subtitle?: string;
  notice?: string;
  actions?: WelcomeAction[];
  recentSessions?: WelcomeRecentSession[];
  selectedSessionIndex?: number;
  tip?: string;
  width?: number;
  compact?: boolean;
}

function defaultWelcomeActions(): WelcomeAction[] {
  return [
    {
      label: t('welcome.action.start'),
      shortcut: t('welcome.action.startShortcut')
    },
    { label: t('welcome.action.commands'), shortcut: '/' },
    { label: t('welcome.action.settings'), shortcut: 'ctrl+p' }
  ];
}

/**
 * 新会话首页卡片（路径由外层顶栏统一渲染，这里不再重复）。
 */
export function WelcomeHome({
  version = '0.1.0',
  modelLabel,
  headline,
  subtitle,
  notice,
  actions,
  recentSessions = [],
  selectedSessionIndex,
  tip,
  width = 72,
  compact = false
}: WelcomeHomeProps) {
  const resolvedHeadline = headline ?? t('welcome.headline');
  const resolvedSubtitle = subtitle ?? t('welcome.subtitle');
  const resolvedTip = tip ?? t('welcome.tip');
  const resolvedActions = actions ?? defaultWelcomeActions();
  const layout = resolveWelcomeLayout(width);
  const cardWidth = layout.cardWidth;
  // 小终端压缩最近会话与品牌；正常尺寸即使有历史也保留完整品牌展示。
  const visibleRecentSessions = compact
    ? recentSessions.slice(0, 2)
    : recentSessions;
  const brandMode = compact ? 'compact' : layout.brandMode;

  return (
    <Box flexDirection="column" alignItems="center" width={width}>
      <Box
        borderStyle="round"
        borderColor={theme.border}
        paddingX={2}
        width={cardWidth}
        flexDirection="column"
      >
        <Box flexDirection="column" alignItems="center" width="100%">
          {brandMode === 'wordmark' ? (
            <Text bold color={theme.brand}>
              {ASCII_WORDMARK.join('\n')}
            </Text>
          ) : (
            <Text bold color={theme.brand}>
              KROSS
            </Text>
          )}
        </Box>

        <Box justifyContent="flex-end" width="100%">
          <Text dimColor>v{version}</Text>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.accent} bold>
            {resolvedHeadline}
          </Text>
        </Box>
        {!compact ? <Text dimColor>{resolvedSubtitle}</Text> : null}

        {modelLabel ? (
          <Box marginTop={0}>
            <Text dimColor>{t('welcome.modelPrefix')}</Text>
            <Text color={theme.brandSoft}>{modelLabel}</Text>
          </Box>
        ) : null}

        {notice ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.statusWarn}>{notice}</Text>
          </Box>
        ) : null}

        {visibleRecentSessions.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Box justifyContent="space-between">
              <Text dimColor>{t('welcome.recentTitle')}</Text>
              <Text
                color={
                  selectedSessionIndex === undefined ? undefined : theme.accent
                }
                dimColor={selectedSessionIndex === undefined}
              >
                {selectedSessionIndex === undefined
                  ? t('welcome.selectHint')
                  : t('welcome.selectedHint')}
              </Text>
            </Box>
            {visibleRecentSessions.map((session, index) => (
              <Box key={session.id}>
                <Text
                  color={
                    index === selectedSessionIndex ? theme.accent : undefined
                  }
                >
                  {index === selectedSessionIndex ? '●' : '○'} {' '}
                </Text>
                <Box flexGrow={1} minWidth={1}>
                  <Text
                    bold={index === selectedSessionIndex}
                    wrap="truncate-end"
                  >
                    {session.title}
                  </Text>
                </Box>
                <Text dimColor> {formatSessionTime(session.updatedAt)}</Text>
              </Box>
            ))}
            {!compact && selectedSessionIndex === undefined ? (
              <Box marginLeft={2}>
                <Text dimColor>{t('welcome.hintIdle')}</Text>
              </Box>
            ) : !compact ? (
              <Box marginLeft={2}>
                <Text color={theme.accent} bold>
                  {t('welcome.hintResume')}
                </Text>
                <Text dimColor>{t('welcome.hintCancel')}</Text>
              </Box>
            ) : null}
          </Box>
        ) : null}

        <Box marginTop={1} flexDirection="column">
          {resolvedActions.map((action) => (
            <Box key={action.label} justifyContent="space-between">
              <Text>{action.label}</Text>
              <Text dimColor>{action.shortcut}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      {resolvedTip && !compact ? (
        <Box marginTop={1} width={cardWidth}>
          <Text dimColor>
            {t('welcome.tipPrefix')}
            {resolvedTip}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

export function resolveWelcomeLayout(width: number): {
  cardWidth: number;
  brandMode: 'wordmark' | 'compact';
} {
  const availableWidth = Math.max(12, Math.floor(width));
  const cardWidth = Math.min(availableWidth, 88);
  return {
    cardWidth,
    brandMode:
      cardWidth - 6 >= ASCII_WORDMARK_WIDTH ? 'wordmark' : 'compact'
  };
}

export function formatCwdLabel(cwd: string, home = homedir()): string {
  const relativePath = relative(home, cwd);
  if (relativePath === '') {
    return '~';
  }
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return cwd;
  }
  return `~${sep}${relativePath}`;
}
