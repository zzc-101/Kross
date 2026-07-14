import React from 'react';
import { Box, Text } from 'ink';

import type { SubagentUiState } from '../app/subagentUi';
import { symbols, theme } from './theme';
import { usePulse } from './usePulse';

/**
 * Compact subagent strip under the conversation viewport.
 * Collapsed = one status line; expanded = details for each active subagent.
 */
export function SubagentPanel({
  subagents,
  expanded = false,
  width
}: {
  subagents: SubagentUiState[];
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
    80,
    primary.status === 'running'
  );

  const caret = expanded ? '▾' : '▸';
  const summaryLine = formatCollapsedLine(primary, subagents.length, spinner, boxWidth);

  return (
    <Box flexDirection="column" width={boxWidth} marginBottom={0} flexShrink={0}>
      <Text>
        <Text color={theme.brand} bold>
          {caret}{' '}
        </Text>
        <Text color={lineTone(primary)}>{summaryLine}</Text>
      </Text>
      {expanded
        ? subagents.map((item) => (
            <ExpandedBlock key={item.subRunId} item={item} width={boxWidth} />
          ))
        : null}
    </Box>
  );
}

function ExpandedBlock({
  item,
  width
}: {
  item: SubagentUiState;
  width: number;
}) {
  const status =
    item.status === 'running'
      ? 'running'
      : item.status === 'completed'
        ? 'done'
        : 'failed';
  const lines = [
    `  ${item.mode} · ${shortId(item.subRunId)} · ${status}`,
    item.promptPreview
      ? `  task ${clip(item.promptPreview, Math.max(16, width - 8))}`
      : undefined,
    item.status === 'running' && item.currentTool
      ? `  tool ${item.currentTool} · ${item.toolCount} calls`
      : item.toolCount > 0
        ? `  tools ${item.toolCount}`
        : undefined,
    item.summaryPreview
      ? `  ${clip(item.summaryPreview, Math.max(16, width - 4))}`
      : item.error
        ? `  ${clip(item.error, Math.max(16, width - 4))}`
        : undefined
  ].filter((line): line is string => Boolean(line));

  return (
    <Box flexDirection="column">
      {lines.map((line) => (
        <Text key={line} dimColor={line.startsWith('  task') || line.startsWith('  tool')}>
          <Text color={lineTone(item)}>{line}</Text>
        </Text>
      ))}
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
        : `${symbols.toolFail} failed`;
  const multi = count > 1 ? ` · +${count - 1}` : '';
  const tail =
    primary.status === 'running' && primary.currentTool
      ? ` · ${primary.currentTool}`
      : primary.summaryPreview
        ? ` · ${primary.summaryPreview}`
        : primary.promptPreview
          ? ` · ${primary.promptPreview}`
          : '';
  return clip(
    `Subagent ${primary.mode}${multi} ${status}${tail}`,
    Math.max(24, width - 2)
  );
}

/**
 * Footer height contribution of the subagent strip.
 * collapsed: 1 line; expanded: 1 summary + details per agent.
 */
export function resolveSubagentPanelHeight(
  subagents: SubagentUiState[],
  expanded = false
): number {
  if (subagents.length === 0) {
    return 0;
  }
  if (!expanded) {
    return 1;
  }
  // summary line + ~3 detail lines per subagent
  return 1 + subagents.length * 3;
}

/**
 * Click hit-test for the subagent strip (1-based terminal rows).
 * Panel sits directly under the message viewport.
 */
export function hitTestSubagentPanel(input: {
  clickRow: number;
  headerHeight: number;
  viewportHeight: number;
  panelHeight: number;
  hasSubagents: boolean;
  contentTopRow?: number;
}): boolean {
  if (!input.hasSubagents || input.panelHeight <= 0) {
    return false;
  }
  const top = (input.contentTopRow ?? 1) + input.headerHeight + input.viewportHeight;
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
  return theme.statusError;
}

function shortId(id: string): string {
  if (id.length <= 18) {
    return id;
  }
  return `${id.slice(0, 16)}…`;
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
