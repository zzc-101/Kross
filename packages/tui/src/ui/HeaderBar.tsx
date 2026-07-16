import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { t, type TodoItem, type TodoStoreSnapshot } from '@kross/core';

import { makeDivider, theme, type UiStatus } from './theme';

export interface HeaderBarProps {
  /** 兼容旧用法；无 branch/cwd 时作为左侧标签 */
  projectName?: string;
  branch?: string;
  cwdLabel?: string;
  /** @deprecated 顶栏不再展示 mode/status；保留以免破坏调用方 */
  mode?: string;
  /** @deprecated 顶栏不再展示 mode/status；保留以免破坏调用方 */
  status?: UiStatus;
  queueLength: number;
  /** @deprecated 权限改在 Composer 页脚展示；保留 prop 以免破坏调用方 */
  permissionMode?: string;
  /** 会话 todo 快照；替换原顶栏权限芯片 */
  todoSnapshot?: TodoStoreSnapshot;
  /** Todo 列表是否展开（显示全部项） */
  todoExpanded?: boolean;
  /** 点击 Todo 芯片/列表时切换展开 */
  onTodoToggle?: () => void;
  /** 顶栏错误提示；名称保留以兼容现有调用。 */
  runtimeError?: string;
  /** 首页仅显示路径 + 上下文用量，不显示状态芯片 */
  compact?: boolean;
  /** 会话上下文占用，如 12K/256K */
  contextUsageLabel?: string;
  /** 0–1，用于用量颜色 */
  contextUsageRatio?: number;
}

function StatusChip({
  label,
  color,
  dim = false
}: {
  label: string;
  color?: string;
  dim?: boolean;
}) {
  return (
    <Text>
      <Text dimColor> </Text>
      <Text color={color} dimColor={dim && !color}>
        {label}
      </Text>
    </Text>
  );
}

export function HeaderBar({
  projectName = 'local',
  branch,
  cwdLabel,
  queueLength,
  todoSnapshot,
  todoExpanded = false,
  runtimeError,
  compact = false,
  contextUsageLabel,
  contextUsageRatio = 0
}: HeaderBarProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns;
  const locationLabel = formatLocationLabel({ branch, cwdLabel, projectName });
  const usageColor = contextUsageTone(contextUsageRatio);
  const todoLabel = formatTodoHeaderLabel(todoSnapshot, todoExpanded);
  const todoLines = todoExpanded
    ? formatTodoHeaderLines(todoSnapshot, resolveTodoListWidth(columns), {
        maxItems: Number.POSITIVE_INFINITY
      })
    : [];
  const todoTone = todoHeaderTone(todoSnapshot);
  const hasTodos = (todoSnapshot?.todos.length ?? 0) > 0;
  const showTodo = hasTodos || columns === undefined || columns >= 60;

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      <Box justifyContent="space-between" width="100%">
        <Box flexShrink={1} minWidth={1} overflowX="hidden">
          <Text dimColor wrap="truncate-end">{locationLabel}</Text>
        </Box>
        <Box flexShrink={0}>
          {contextUsageLabel ? (
            <Text color={usageColor}>{contextUsageLabel}</Text>
          ) : null}
          {/* Todo 芯片：有任务时可点展开（由 App 订阅点击区域） */}
          {showTodo ? (
            <StatusChip
              label={hasTodos ? todoLabel : t('header.todo.empty')}
              color={todoTone}
              dim={!todoTone}
            />
          ) : null}
          {queueLength > 0 ? (
            <StatusChip
              label={t('header.queue', { count: queueLength })}
              color={theme.statusBusy}
            />
          ) : null}
        </Box>
      </Box>
      {todoLines.length > 0 ? (
        <Box flexDirection="column" width="100%">
          {todoLines.map((line) => (
            <Text key={line.key} color={line.color} dimColor={line.dim}>
              {line.text}
            </Text>
          ))}
        </Box>
      ) : null}
      {!compact ? (
        <Text dimColor>{makeDivider(columns ? columns - 2 : undefined)}</Text>
      ) : null}
      {runtimeError ? (
        <Box>
          <Text color={theme.statusError}>⚠ {runtimeError}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Completed uses checkmark; others use compact markers. */
export const TODO_STATUS_MARK: Record<TodoItem['status'], string> = {
  pending: '☐',
  in_progress: '◻',
  completed: '✓',
  cancelled: '−'
};

export function formatTodoHeaderLabel(
  snapshot: TodoStoreSnapshot | undefined,
  expanded = false
): string {
  if (!snapshot || snapshot.todos.length === 0) {
    return t('header.todo.empty');
  }
  const done = snapshot.counts.completed + snapshot.counts.cancelled;
  const base = t('header.todo.progress', {
    done,
    total: snapshot.todos.length
  });
  const caret = expanded ? '▾' : '▸';
  return `${base} ${caret}`;
}

export function formatTodoHeaderLines(
  snapshot: TodoStoreSnapshot | undefined,
  maxWidth: number,
  options: { maxItems?: number } = {}
): Array<{ key: string; text: string; color?: string; dim?: boolean }> {
  if (!snapshot || snapshot.todos.length === 0) {
    return [];
  }
  const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
  // Keep store order stable — do not re-sort by status when items complete.
  const ordered = snapshot.todos;
  const visible = Number.isFinite(maxItems)
    ? ordered.slice(0, maxItems)
    : ordered;
  const hidden = ordered.length - visible.length;
  const lines: Array<{ key: string; text: string; color?: string; dim?: boolean }> =
    visible.map((item) => {
    const mark = TODO_STATUS_MARK[item.status];
    const raw = `${mark} ${item.content}`;
    return {
      key: item.id,
      text: truncateTodoLine(raw, maxWidth),
      color: todoItemTone(item.status),
      dim: item.status === 'pending' || item.status === 'cancelled'
    };
    });
  if (hidden > 0) {
    lines.push({
      key: '__more__',
      text: t('header.todo.more', { count: hidden }),
      dim: true
    });
  }
  return lines;
}

/**
 * Header rows used for layout / click hit-testing (1-based terminal rows start at 1).
 * top row + optional expanded todo lines + divider + optional error.
 */
export function resolveHeaderHeight(input: {
  compact: boolean;
  hasError: boolean;
  todoCount: number;
  todoExpanded: boolean;
}): number {
  let height = 1;
  if (input.todoExpanded && input.todoCount > 0) {
    height += input.todoCount;
  }
  if (!input.compact) {
    height += 1; // divider
  }
  if (input.hasError) {
    height += 1;
  }
  return height;
}

/**
 * Whether a mouse click (1-based row/col) hits the Todo toggle region.
 * Top row right half, or any expanded todo list row.
 */
export function hitTestTodoToggle(input: {
  clickRow: number;
  clickCol: number;
  columns: number;
  compact: boolean;
  hasError: boolean;
  todoCount: number;
  todoExpanded: boolean;
  /** Shell content starts at this 1-based row (default 1). */
  contentTopRow?: number;
}): boolean {
  if (input.todoCount <= 0) {
    return false;
  }
  const top = input.contentTopRow ?? 1;
  const headerHeight = resolveHeaderHeight({
    compact: input.compact,
    hasError: input.hasError,
    todoCount: input.todoCount,
    todoExpanded: input.todoExpanded
  });
  const headerBottom = top + headerHeight - 1;
  if (input.clickRow < top || input.clickRow > headerBottom) {
    return false;
  }

  // Expanded list rows (below top status row) always toggle.
  if (input.todoExpanded && input.clickRow > top) {
    // Don't treat divider/error as todo lines.
    const listBottom = top + input.todoCount;
    return input.clickRow <= listBottom;
  }

  // Top row: right half is the Todo chip area.
  if (input.clickRow === top) {
    const mid = Math.max(1, Math.floor(input.columns * 0.42));
    return input.clickCol >= mid;
  }

  return false;
}

function todoItemTone(
  status: TodoItem['status']
): string | undefined {
  switch (status) {
    case 'in_progress':
      return theme.statusBusy;
    case 'completed':
      return theme.statusReady;
    case 'cancelled':
      return theme.chip;
    default:
      return undefined;
  }
}

function todoHeaderTone(
  snapshot: TodoStoreSnapshot | undefined
): string | undefined {
  if (!snapshot || snapshot.todos.length === 0) {
    return undefined;
  }
  if (snapshot.counts.in_progress > 0) {
    return theme.statusBusy;
  }
  if (
    snapshot.counts.completed + snapshot.counts.cancelled >=
    snapshot.todos.length
  ) {
    return theme.statusReady;
  }
  return theme.brandSoft;
}

function resolveTodoListWidth(columns: number | undefined): number {
  return Math.max(24, Math.min(72, (columns ?? 80) - 4));
}

function truncateTodoLine(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) {
    return text;
  }
  if (maxWidth <= 1) {
    return '…';
  }
  return `${text.slice(0, maxWidth - 1)}…`;
}

export function formatLocationLabel(input: {
  branch?: string;
  cwdLabel?: string;
  projectName?: string;
}): string {
  const parts: string[] = [];
  if (input.branch) {
    parts.push(input.branch);
  }
  if (input.cwdLabel) {
    parts.push(input.cwdLabel);
  }
  if (parts.length > 0) {
    return parts.join('  ');
  }
  return input.projectName ?? 'local';
}

export function contextUsageTone(
  ratio: number
): typeof theme.statusReady | typeof theme.statusWarn | typeof theme.statusError | typeof theme.chip {
  if (ratio >= 1) {
    return theme.statusError;
  }
  if (ratio >= 0.8) {
    return theme.statusWarn;
  }
  if (ratio > 0) {
    return theme.statusReady;
  }
  return theme.chip;
}
