import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

import { formatPermissionFooter, type PermissionMode } from '@kross/core';

import { symbols, theme } from './theme';

export const COMPOSER_HEIGHT = 3;
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
  permissionMode = 'default',
  width
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  modelLabel?: string;
  permissionMode?: PermissionMode;
  /** 全宽时传入终端列数 */
  width?: number;
}) {
  const footerLabel = useMemo(
    () => `${modelLabel} · ${formatPermissionFooter(permissionMode)}`,
    [modelLabel, permissionMode]
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

  return (
    <Box
      flexDirection="column"
      width={boxWidth}
      height={COMPOSER_HEIGHT}
      marginBottom={COMPOSER_BOTTOM_GAP}
      flexShrink={0}
    >
      <Text color={theme.border}>{topBorder}</Text>
      <Box width={boxWidth} height={1}>
        <Text color={theme.border}>{symbols.boxVertical}</Text>
        <Box paddingX={1} flexGrow={1}>
          <Text bold>{symbols.prompt} </Text>
          <Box flexGrow={1}>
            <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
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

function createComposerBorder(
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
  const rightRuleWidth = 1;
  const leftRuleWidth = Math.max(
    1,
    innerWidth - bottomLabel.length - rightRuleWidth
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
        innerWidth - leftRuleWidth - bottomLabel.length
      ) + symbols.boxBottomRight
  };
}

function truncateLabel(label: string, maxWidth: number): string {
  if (label.length <= maxWidth) {
    return label;
  }
  if (maxWidth <= 1) {
    return '…';
  }
  return `${label.slice(0, maxWidth - 1)}…`;
}

export function HelpHint() {
  return (
    <Box marginTop={0}>
      <Text dimColor>
        /help · ctrl+p 模型 · shift+tab 权限 · click/ctrl+o Thought
      </Text>
    </Box>
  );
}
