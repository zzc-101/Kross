import React from 'react';
import { Box, Text } from 'ink';

import type { SubagentUiState } from '../app/subagentUi';
import { symbols, theme } from './theme';
import { usePulse } from './usePulse';

/**
 * 底部单行子代理条（位于 Composer 下方）。
 * 只显示：Subagent · {短标题} · 状态；不展开长描述。
 */
export function SubagentPanel({
  subagents,
  width
}: {
  subagents: SubagentUiState[];
  /** @deprecated 始终单行，忽略 expand */
  expanded?: boolean;
  width?: number;
}) {
  if (subagents.length === 0) {
    return null;
  }

  const boxWidth = Math.max(36, width ?? 48);
  const primary = subagents[0]!;
  const spinner = usePulse(
    symbols.busyFrames,
    200,
    primary.status === 'running'
  );
  const line = formatCollapsedLine(
    primary,
    subagents.length,
    spinner,
    boxWidth
  );

  return (
    <Box width={boxWidth} height={1} flexShrink={0} marginTop={0}>
      <Text color={lineTone(primary)}>{line}</Text>
    </Box>
  );
}

export function formatCollapsedLine(
  primary: SubagentUiState,
  count: number,
  spinner: string,
  width: number
): string {
  const status =
    primary.status === 'running'
      ? `${spinner} running`
      : primary.status === 'completed'
        ? `${symbols.toolOk} done`
        : primary.status === 'cancelled'
          ? `${symbols.toolFail} interrupted`
          : `${symbols.toolFail} failed`;
  const multi = count > 1 ? ` +${count - 1}` : '';
  const title = resolveDisplayTitle(primary);
  // 单行：Subagent · 短标题 · 状态（不再拼 prompt 全文）
  return clip(`Subagent · ${title}${multi} · ${status}`, Math.max(24, width - 2));
}

function resolveDisplayTitle(item: SubagentUiState): string {
  if (item.title && item.title.trim().length > 0) {
    return item.title.trim();
  }
  if (item.promptPreview && item.promptPreview.trim().length > 0) {
    return clip(item.promptPreview, 36);
  }
  return item.mode || 'Task';
}

/**
 * Footer height：始终最多 1 行（有子代理时）。
 */
export function resolveSubagentPanelHeight(
  subagents: SubagentUiState[],
  _expanded = false
): number {
  return subagents.length === 0 ? 0 : 1;
}

/**
 * Click hit-test：条在 footer 最底部（Composer 下方）。
 * footerAboveSubagent = footer 总高 − 本条高度。
 */
export function hitTestSubagentPanel(input: {
  clickRow: number;
  headerHeight: number;
  viewportHeight: number;
  panelHeight: number;
  hasSubagents: boolean;
  contentTopRow?: number;
  /** 子代理条上方 footer 占用的行数（thinking + composer + …） */
  footerRowsAbove?: number;
}): boolean {
  if (!input.hasSubagents || input.panelHeight <= 0) {
    return false;
  }
  const contentTop = input.contentTopRow ?? 1;
  const above = input.footerRowsAbove ?? 0;
  const top =
    contentTop + input.headerHeight + input.viewportHeight + above;
  const bottom = top + input.panelHeight - 1;
  return input.clickRow >= top && input.clickRow <= bottom;
}

function lineTone(item: SubagentUiState): string {
  if (item.status === 'running') {
    return theme.statusBusy;
  }
  if (item.status === 'completed') {
    return theme.statusReady;
  }
  if (item.status === 'cancelled') {
    return theme.statusWarn;
  }
  return theme.statusError;
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
