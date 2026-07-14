import React from 'react';
import { Box, Text, useStdout } from 'ink';

import { t, type PendingToolApproval } from '@kross/core';

import {
  formatApprovalReason,
  formatApprovalPresentation,
  type ApprovalSelection
} from './approvalPresentation';
import { displayWidth } from './markdownParse';
import { riskTone, symbols, theme } from './theme';
import { usePulse } from './usePulse';

export { defaultApprovalSelection } from './approvalPresentation';

export function ApprovalPanel({
  approval,
  selection,
  width: availableWidth
}: {
  approval: PendingToolApproval;
  selection: ApprovalSelection;
  width?: number;
}) {
  const highlight = usePulse(
    [symbols.approvePointer, symbols.approvePointerSoft],
    380,
    true
  );
  const { stdout } = useStdout();
  const width = resolveApprovalPanelWidth(
    availableWidth ?? (stdout?.columns ?? 48) - 4
  );
  const innerWidth = width - 4; // border + space + content + space + border
  const hRule = symbols.boxHorizontal.repeat(width - 2);
  const riskColor = riskTone(approval.risk);
  const presentation = formatApprovalPresentation(approval.risk);
  const previewLines = splitPreviewLines(approval.inputPreview ?? '', innerWidth - 6);

  /** 带左右边框的内容行 */
  const Row = ({ children }: { children: React.ReactNode }) => (
    <Box>
      <Text color={theme.border}>{symbols.boxVertical} </Text>
      <Box flexGrow={1} flexShrink={1} overflowX="hidden">
        {children}
      </Box>
      <Text color={theme.border}> {symbols.boxVertical}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} width={width}>
      <Text color={theme.statusWarn}>
        {symbols.boxTopLeft}
        {hRule}
        {symbols.boxTopRight}
      </Text>

      <Row>
        <Text color={theme.statusWarn} bold>
          {presentation.title}
        </Text>
      </Row>

      <Row>
        <Text dimColor>工具  </Text>
        <Text bold>{approval.toolName}</Text>
        <Text dimColor>  ·  风险  </Text>
        <Text color={riskColor} bold>
          {presentation.riskLabel}
        </Text>
      </Row>

      {previewLines.map((line, index) => (
        <Row key={`preview-${index}`}>
          {index === 0 ? (
            <Text dimColor>{presentation.inputLabel}  </Text>
          ) : (
            <Text dimColor>      </Text>
          )}
          <PreviewLine text={line} />
        </Row>
      ))}

      {approval.reason ? (
        <Row>
          <Text dimColor>说明  </Text>
          <Text>
            {truncate(formatApprovalReason(approval.reason), innerWidth - 6)}
          </Text>
        </Row>
      ) : null}

      <Row>
        <Text
          color={selection === 'approve' ? theme.approve : undefined}
          bold={selection === 'approve'}
          dimColor={selection !== 'approve'}
        >
          {selection === 'approve' ? `${highlight} ` : '  '}
          允许一次
        </Text>
        <Text>    </Text>
        <Text
          color={selection === 'reject' ? theme.reject : undefined}
          bold={selection === 'reject'}
          dimColor={selection !== 'reject'}
        >
          {selection === 'reject' ? `${highlight} ` : '  '}
          拒绝
        </Text>
      </Row>

      <Text color={theme.border}>
        {symbols.boxBottomLeft}
        {hRule}
        {symbols.boxBottomRight}
      </Text>
      <Text dimColor>{t('approval.hotkeys')}</Text>
    </Box>
  );
}

export function resolveApprovalPanelWidth(availableWidth: number): number {
  return Math.max(30, Math.min(Math.floor(availableWidth), 72));
}

export function resolveApprovalPanelHeight(
  approval: Pick<PendingToolApproval, 'inputPreview' | 'reason'>
): number {
  const previewRows = Math.min(4, (approval.inputPreview || '').split('\n').length);
  // 上下留白 2 + 框内固定行 5 + 预览 + 可选说明 + 框外提示 1
  return 8 + previewRows + (approval.reason ? 1 : 0);
}

function PreviewLine({ text }: { text: string }) {
  if (text.startsWith('+ ') || text.startsWith('+')) {
    return <Text color={theme.statusReady}>{text}</Text>;
  }
  if (text.startsWith('- ') || (text.startsWith('-') && !text.startsWith('---'))) {
    return <Text color={theme.statusError}>{text}</Text>;
  }
  return <Text>{text}</Text>;
}

function splitPreviewLines(preview: string, maxWidth: number): string[] {
  if (!preview) {
    return [''];
  }
  const lines = preview.split('\n').map((line) => truncate(line, maxWidth));
  // 审批面板最多展示 4 行，避免占满屏幕
  if (lines.length <= 4) {
    return lines;
  }
  return [...lines.slice(0, 3), '…'];
}

function truncate(text: string, max: number): string {
  if (displayWidth(text) <= max) {
    return text;
  }
  const target = Math.max(0, max - 1);
  let output = '';
  let used = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (used + charWidth > target) {
      break;
    }
    output += char;
    used += charWidth;
  }
  return `${output}…`;
}
