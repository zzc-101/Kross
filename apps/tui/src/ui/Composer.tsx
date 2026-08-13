import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { t, type AgentMode, type PermissionMode } from '@kross/core';

import { displayWidth } from './markdownParse';
import {
  formatAgentModeFooterLabel,
  formatPermissionModeLabel,
  symbols,
  theme
} from './theme';

export const COMPOSER_FRAME_HEIGHT = 3;
export const COMPOSER_FEEDBACK_HEIGHT = 1;
export const COMPOSER_HEIGHT =
  COMPOSER_FEEDBACK_HEIGHT + COMPOSER_FRAME_HEIGHT;
export const COMPOSER_BOTTOM_GAP = 3;
export const COMPOSER_FOOTER_HEIGHT =
  COMPOSER_HEIGHT + COMPOSER_BOTTOM_GAP;
const DEFAULT_COMPOSER_WIDTH = 48;

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  modelLabel = 'no model',
  agentMode = 'auto',
  permissionMode = 'default',
  width,
  bottomGap = COMPOSER_BOTTOM_GAP,
  clipboardFeedback
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  modelLabel?: string;
  /** 当前 agent 模式（auto/plan/conductor） */
  agentMode?: AgentMode | string;
  permissionMode?: PermissionMode;
  /** 全宽时传入终端列数 */
  width?: number;
  /** 输入框下方留白；有底部子代理条时可缩小为 0/1 */
  bottomGap?: number;
  /** 鼠标拖选松开后的短暂复制结果。 */
  clipboardFeedback?: 'copied' | 'failed';
}) {
  const displayModelLabel =
    modelLabel === 'no model' ? t('composer.noModel') : modelLabel;
  const footerLabel = useMemo(
    () =>
      `${displayModelLabel} · ${formatAgentModeFooterLabel(agentMode)} · ${formatPermissionModeLabel(permissionMode)}`,
    [agentMode, displayModelLabel, permissionMode]
  );

  if (disabled) {
    return null;
  }

  const boxWidth = Math.max(
    12,
    Math.floor(width && width > 0 ? width : DEFAULT_COMPOSER_WIDTH)
  );
  const { topBorder, bottomLeft, bottomLabel, bottomRight } =
    createComposerBorder(boxWidth, footerLabel);

  const gap = Math.max(0, bottomGap);

  return (
    <Box
      flexDirection="column"
      width={boxWidth}
      height={COMPOSER_HEIGHT}
      marginBottom={gap}
      flexShrink={0}
    >
      <Box
        width={boxWidth}
        height={COMPOSER_FEEDBACK_HEIGHT}
        justifyContent="flex-end"
        paddingRight={1}
      >
        {clipboardFeedback ? (
          <Text
            color={
              clipboardFeedback === 'copied'
                ? theme.statusReady
                : theme.statusError
            }
          >
            {clipboardFeedback === 'copied'
              ? t('clipboard.copied')
              : t('clipboard.failed')}
          </Text>
        ) : null}
      </Box>
      <Text color={theme.border}>{topBorder}</Text>
      <Box width={boxWidth} height={1}>
        <Text color={theme.border}>{symbols.boxVertical}</Text>
        <Box paddingX={1} flexGrow={1}>
          <Text bold>{symbols.prompt} </Text>
          <Box flexGrow={1}>
            <ComposerTextInput
              value={value}
              onChange={onChange}
              onSubmit={onSubmit}
              placeholder={t('composer.placeholder')}
            />
          </Box>
        </Box>
        <Text color={theme.border}>{symbols.boxVertical}</Text>
      </Box>
      <Box width={boxWidth} height={1}>
        <Text color={theme.border}>{bottomLeft}</Text>
        <Text dimColor>{bottomLabel}</Text>
        <Text color={theme.border}>{bottomRight}</Text>
      </Box>
    </Box>
  );
}

function ComposerTextInput({
  value,
  onChange,
  onSubmit,
  placeholder
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
}) {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  useEffect(() => {
    setCursorOffset((current) => Math.min(current, value.length));
  }, [value]);

  useInput((input, key) => {
    // Ink 会把同一次按键分发给所有 useInput 监听器。全局 ctrl 快捷键
    // 已由 useAppKeyboard 处理，这里必须忽略，否则 ctrl+p 会把 p 写进输入框。
    if (shouldIgnoreComposerInput(key)) {
      return;
    }

    if (key.return) {
      onSubmit(value);
      return;
    }

    if (key.leftArrow) {
      setCursorOffset((current) => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      setCursorOffset((current) => Math.min(value.length, current + 1));
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorOffset === 0) {
        return;
      }
      onChange(
        value.slice(0, cursorOffset - 1) + value.slice(cursorOffset)
      );
      setCursorOffset((current) => Math.max(0, current - 1));
      return;
    }

    if (input.length === 0) {
      return;
    }

    onChange(value.slice(0, cursorOffset) + input + value.slice(cursorOffset));
    setCursorOffset((current) => current + input.length);
  });

  if (value.length === 0) {
    return (
      <Text>
        <Text inverse>{placeholder[0] ?? ' '}</Text>
        <Text dimColor>{placeholder.slice(1)}</Text>
      </Text>
    );
  }

  return (
    <Text>
      {value.slice(0, cursorOffset)}
      <Text inverse>{value[cursorOffset] ?? ' '}</Text>
      {value.slice(cursorOffset + 1)}
    </Text>
  );
}

export function shouldIgnoreComposerInput(key: {
  ctrl?: boolean;
  meta?: boolean;
  escape?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}): boolean {
  return Boolean(
    key.ctrl ||
      key.meta ||
      key.escape ||
      key.tab ||
      key.upArrow ||
      key.downArrow
  );
}

export function createComposerBorder(
  width: number,
  footerLabel: string
): {
  topBorder: string;
  bottomLeft: string;
  bottomLabel: string;
  bottomRight: string;
} {
  const innerWidth = width - 2;
  const labelWidth = Math.max(1, innerWidth - 4);
  const fittedLabel = truncateLabel(footerLabel, labelWidth);
  const bottomLabel = ` ${fittedLabel} `;
  const bottomLabelWidth = displayWidth(bottomLabel);
  const rightRuleWidth = 1;
  const leftRuleWidth = Math.max(
    1,
    innerWidth - bottomLabelWidth - rightRuleWidth
  );

  return {
    topBorder:
      symbols.boxTopLeft +
      symbols.boxHorizontal.repeat(innerWidth) +
      symbols.boxTopRight,
    bottomLeft:
      symbols.boxBottomLeft +
      symbols.boxHorizontal.repeat(leftRuleWidth),
    bottomLabel,
    bottomRight:
      symbols.boxHorizontal.repeat(
        innerWidth - leftRuleWidth - bottomLabelWidth
      ) + symbols.boxBottomRight
  };
}

function truncateLabel(label: string, maxWidth: number): string {
  if (displayWidth(label) <= maxWidth) {
    return label;
  }
  if (maxWidth <= 1) {
    return '…';
  }
  const target = maxWidth - 1;
  let output = '';
  let used = 0;
  for (const char of label) {
    const charWidth = displayWidth(char);
    if (used + charWidth > target) {
      break;
    }
    output += char;
    used += charWidth;
  }
  return `${output}…`;
}

export function HelpHint() {
  return (
    <Box marginTop={0}>
      <Text dimColor>{t('composer.helpHint')}</Text>
    </Box>
  );
}
