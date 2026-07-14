import React from 'react';
import { Box, Text } from 'ink';

import { theme } from './theme';

export const ASCII_WORDMARK = [
  '   __ __  ____   ____   ____   ____',
  '  / //_/ / __ \\ / __ \\ / __/  / __/',
  ' / ,<   / /_/ // /_/ /_\\ \\   _\\ \\',
  '/_/|_| /_____/ \\____//___/  /___/'
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
}

const defaultActions: WelcomeAction[] = [
  { label: '输入内容开始新会话', shortcut: '输入后 ↵' },
  { label: '查看命令', shortcut: '/' },
  { label: '模型与思考强度', shortcut: 'ctrl+p' }
];

/**
 * 新会话首页卡片（路径由外层顶栏统一渲染，这里不再重复）。
 */
export function WelcomeHome({
  version = '0.1.0',
  modelLabel,
  headline = '随时可以开始',
  subtitle = '在当前工作区规划、调用工具并保留运行记录。',
  notice,
  actions = defaultActions,
  recentSessions = [],
  selectedSessionIndex,
  tip = '输入 / 查看全部命令',
  width = 72
}: WelcomeHomeProps) {
  const layout = resolveWelcomeLayout(width);
  const cardWidth = layout.cardWidth;
  // 最近会话区比品牌展示更重要；有历史时压缩为单行 Logo，避免 24 行终端裁剪。
  const brandMode = recentSessions.length > 0 ? 'compact' : layout.brandMode;

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
            ASCII_WORDMARK.map((line) => (
              <Text key={line} color={theme.brandMuted}>
                {line}
              </Text>
            ))
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
            {headline}
          </Text>
        </Box>
        <Text dimColor>{subtitle}</Text>

        {modelLabel ? (
          <Box marginTop={0}>
            <Text dimColor>模型 </Text>
            <Text color={theme.brandSoft}>{modelLabel}</Text>
          </Box>
        ) : null}

        {notice ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.statusWarn}>{notice}</Text>
          </Box>
        ) : null}

        {recentSessions.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Box justifyContent="space-between">
              <Text dimColor>最近会话</Text>
              <Text
                color={
                  selectedSessionIndex === undefined ? undefined : theme.accent
                }
                dimColor={selectedSessionIndex === undefined}
              >
                {selectedSessionIndex === undefined
                  ? '↑↓ 选择'
                  : '已选中 · Esc 取消'}
              </Text>
            </Box>
            {recentSessions.map((session, index) => (
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
            {selectedSessionIndex === undefined ? (
              <Box marginLeft={2}>
                <Text dimColor>使用 ↑↓ 选择会话 · 输入内容开始新会话</Text>
              </Box>
            ) : (
              <Box marginLeft={2}>
                <Text color={theme.accent} bold>
                  Enter 恢复已选中会话
                </Text>
                <Text dimColor> · Esc 取消选择</Text>
              </Box>
            )}
          </Box>
        ) : null}

        <Box marginTop={1} flexDirection="column">
          {actions.map((action) => (
            <Box key={action.label} justifyContent="space-between">
              <Text>{action.label}</Text>
              <Text dimColor>{action.shortcut}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      {tip ? (
        <Box marginTop={1} width={cardWidth}>
          <Text dimColor>提示：{tip}</Text>
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
  const availableWidth = Math.max(36, Math.floor(width));
  const cardWidth = Math.min(availableWidth, 88);
  return {
    cardWidth,
    brandMode:
      cardWidth - 6 >= ASCII_WORDMARK_WIDTH ? 'wordmark' : 'compact'
  };
}

export function formatCwdLabel(cwd: string, home = process.env.HOME): string {
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}` || '~';
  }
  return cwd;
}
