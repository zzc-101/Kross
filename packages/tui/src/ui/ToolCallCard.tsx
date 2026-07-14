import React from 'react';
import { Box, Text } from 'ink';
import { t } from '@kross/core';

import type { ToolCallItem, ToolCallState, ToolDetailLine } from './MessageLine';
import { symbols, theme } from './theme';
import { usePulse } from './usePulse';
import {
  ensureToolItems,
  formatLineStatsLabel,
  formatToolTitle,
  resolveLineStats
} from './toolDisplay';

/**
 * 工具调用单行摘要（默认折叠）；展开时渲染 detailLines（与全屏 paint 一致）。
 * 非全屏文档流用；全屏视口走 messagePaint。
 */
export function ToolCallCard({
  tool,
  expanded = false
}: {
  tool: ToolCallState;
  expanded?: boolean;
}) {
  const spinner = usePulse(symbols.busyFrames, 80, tool.status === 'running');
  const items = ensureToolItems(tool);
  const baseTitle = formatToolTitleWithoutDelta({ ...tool, items });
  const stats = resolveLineStats(tool);
  const showDelta =
    stats !== undefined &&
    (tool.name === 'Edit' || tool.name === 'Write') &&
    tool.status !== 'running' &&
    tool.status !== 'awaiting';
  const status = formatToolStatus(tool.status, spinner);
  const canExpand =
    items.length > 0 || (tool.detailLines !== undefined && tool.detailLines.length > 0);
  const statusHint = statusExtraHint(tool);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.marker}>
          {canExpand ? `${symbols.markerSquare} ` : '  '}
        </Text>
        <Text color={theme.brand} bold>
          {baseTitle}
        </Text>
        {showDelta && stats ? (
          <>
            <Text> </Text>
            <LineDeltaText stats={stats} />
          </>
        ) : null}
        {status ? (
          <>
            <Text dimColor>  </Text>
            <Text color={status.color}>{status.label}</Text>
          </>
        ) : null}
        {statusHint ? <Text dimColor> · {statusHint}</Text> : null}
        {canExpand && !expanded && items.length > 1 ? (
          <Text dimColor> · ctrl+e</Text>
        ) : null}
      </Box>

      {expanded ? <ExpandedToolBody tool={tool} items={items} /> : null}
    </Box>
  );
}

function ExpandedToolBody({
  tool,
  items
}: {
  tool: ToolCallState;
  items: ToolCallItem[];
}) {
  // 聚合多文件：列路径
  if (items.length > 1) {
    return (
      <Box flexDirection="column">
        {items.map((item, index) => (
          <Box key={item.callId ?? `${item.path ?? 'item'}-${index}`}>
            <Text dimColor>
              {'  '}
              {symbols.systemPrefix}{' '}
            </Text>
            <Text dimColor>
              {item.path ?? item.preview ?? item.summary ?? tool.name}
            </Text>
            {item.status === 'failed' || item.status === 'denied' ? (
              <Text color={theme.statusError}>  {item.status}</Text>
            ) : null}
          </Box>
        ))}
      </Box>
    );
  }

  const detail = tool.detailLines ?? [];
  if (detail.length > 0) {
    return (
      <Box flexDirection="column">
        {detail.map((line, index) => (
          <DetailLineView key={`d-${index}`} line={line} />
        ))}
        {tool.detailTruncated ? (
          <Text dimColor>  … truncated</Text>
        ) : null}
      </Box>
    );
  }

  // 单 item 兜底
  const item = items[0];
  if (!item) {
    return null;
  }
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>
          {'  '}
          {symbols.systemPrefix}{' '}
        </Text>
        <Text dimColor>
          {item.path ?? item.preview ?? item.summary ?? tool.name}
        </Text>
      </Box>
      {item.summary ? (
        <Text dimColor>
          {'    '}
          {item.summary}
        </Text>
      ) : null}
    </Box>
  );
}

function DetailLineView({ line }: { line: ToolDetailLine }) {
  // 正文 line.text 原样展示，不做裁剪/替换
  const num =
    typeof line.lineNo === 'number' && line.lineNo >= 1
      ? String(line.lineNo).padStart(4, ' ')
      : '    ';

  if (line.op === 'add') {
    return (
      <Text color={theme.diffOnBg} backgroundColor={theme.diffAddBg}>
        {num} + {line.text}
      </Text>
    );
  }
  if (line.op === 'del') {
    return (
      <Text color={theme.diffOnBg} backgroundColor={theme.diffDelBg}>
        {num} - {line.text}
      </Text>
    );
  }
  if (line.op === 'ctx') {
    return (
      <Text dimColor>
        {num}   {line.text}
      </Text>
    );
  }
  return <Text dimColor>{line.text}</Text>;
}

function LineDeltaText({
  stats
}: {
  stats: { linesAdded: number; linesRemoved: number };
}) {
  const { linesAdded, linesRemoved } = stats;
  if (linesAdded === 0 && linesRemoved === 0) {
    return <Text dimColor>±0</Text>;
  }
  return (
    <Text>
      {linesAdded > 0 ? (
        <Text color={theme.statusReady}>+{linesAdded}</Text>
      ) : null}
      {linesAdded > 0 && linesRemoved > 0 ? <Text> </Text> : null}
      {linesRemoved > 0 ? (
        <Text color={theme.statusError}>-{linesRemoved}</Text>
      ) : null}
    </Text>
  );
}

function formatToolTitleWithoutDelta(tool: ToolCallState): string {
  const full = formatToolTitle(tool);
  const stats = resolveLineStats(tool);
  if (!stats || (tool.name !== 'Edit' && tool.name !== 'Write')) {
    return full;
  }
  const label = formatLineStatsLabel(stats);
  if (full.endsWith(` ${label}`)) {
    return full.slice(0, -(label.length + 1));
  }
  return full;
}

function formatToolStatus(
  status: ToolCallState['status'],
  spinner: string
): { label: string; color: string } | null {
  switch (status) {
    case 'running':
      return { label: spinner, color: theme.statusBusy };
    case 'completed':
      return { label: symbols.toolOk, color: theme.statusReady };
    case 'failed':
      return {
        label: `${symbols.toolFail} ${t('tool.status.failed')}`,
        color: theme.statusError
      };
    case 'denied':
      return {
        label: `${symbols.toolFail} ${t('tool.status.rejected')}`,
        color: theme.statusError
      };
    case 'awaiting':
      return {
        label: `${symbols.toolWait} ${t('tool.status.waiting')}`,
        color: theme.statusWarn
      };
    default:
      return { label: status, color: theme.chip };
  }
}

function statusExtraHint(tool: ToolCallState): string | undefined {
  const summary = tool.summary?.replace(/\s+/g, ' ').trim();
  if (!summary) {
    return undefined;
  }

  if (tool.status === 'failed' || tool.status === 'denied') {
    return clip(summary, 48);
  }

  if (tool.status === 'awaiting' || tool.status !== 'completed') {
    return undefined;
  }

  if (tool.name === 'Edit') {
    if (summary === 'no match' || summary.startsWith('ambiguous')) {
      return clip(summary, 40);
    }
    const replaced = summary.match(/^replaced\s+(\d+)/i);
    if (replaced && Number(replaced[1]) > 1) {
      return `${replaced[1]}×`;
    }
    return undefined;
  }

  if (tool.name === 'Bash') {
    const exit = summary.match(/exit=(-?\d+)/i);
    if (exit && exit[1] !== '0') {
      return `exit ${exit[1]}`;
    }
  }

  return undefined;
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
