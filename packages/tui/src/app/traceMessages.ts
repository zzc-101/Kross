import {
  formatToolInputPreview as formatCoreToolInputPreview,
  type AgentResult,
  type TraceEvent
} from '@kross/core';

import type { ChatMessage, ToolCallState, ToolDetailLine } from '../ui';

export function handleTraceEvent(
  event: TraceEvent,
  handlers: {
    upsertToolMessage: (key: string, tool: ToolCallState) => number;
    setLoadingVariant: (variant: 'thinking' | 'tool') => void;
    setAwaitingReply: (value: boolean) => void;
    setStreamingMessageId: (id: number | undefined) => void;
  }
): void {
  const payload = event.payload;
  const toolName =
    typeof payload.toolName === 'string' ? payload.toolName : undefined;
  if (!toolName) {
    return;
  }

  const callId =
    typeof payload.callId === 'string' ? payload.callId : undefined;
  const key = `${event.runId}:${callId ?? toolName}`;
  const risk = typeof payload.risk === 'string' ? payload.risk : undefined;
  const summary =
    typeof payload.summary === 'string' ? payload.summary : undefined;
  const durationMs =
    typeof payload.durationMs === 'number' ? payload.durationMs : undefined;
  const inputPreview = formatToolInputPreview(toolName, payload.input);
  const lineStats = extractLineStats(payload.data, summary);

  if (event.type === 'tool_call.approval_required') {
    handlers.setLoadingVariant('tool');
    handlers.setAwaitingReply(false);
    handlers.setStreamingMessageId(undefined);
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'awaiting',
      summary:
        typeof payload.reason === 'string'
          ? payload.reason
          : 'awaiting approval',
      inputPreview,
      detailLines: buildAwaitingDetail(toolName, inputPreview)
    });
    return;
  }

  if (event.type === 'tool_call.started') {
    handlers.setLoadingVariant('tool');
    handlers.setAwaitingReply(true);
    handlers.setStreamingMessageId(undefined);
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'running',
      inputPreview,
      detailLines: buildRunningDetail(toolName, inputPreview)
    });
    return;
  }

  if (event.type === 'tool_call.completed') {
    const detail = buildCompletedDetail(
      toolName,
      payload.data,
      summary,
      typeof payload.contentPreview === 'string'
        ? payload.contentPreview
        : undefined,
      inputPreview
    );
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'completed',
      summary,
      inputPreview,
      durationMs,
      linesAdded: lineStats?.linesAdded,
      linesRemoved: lineStats?.linesRemoved,
      detailLines: detail.lines,
      detailTruncated: detail.truncated
    });
    return;
  }

  if (event.type === 'tool_call.failed') {
    const failSummary =
      summary ??
      (typeof payload.message === 'string' ? payload.message : 'tool failed');
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'failed',
      summary: failSummary,
      inputPreview,
      durationMs,
      detailLines: [{ text: failSummary, op: 'meta' }]
    });
    return;
  }

  if (event.type === 'tool_call.denied') {
    const reason =
      typeof payload.reason === 'string' ? payload.reason : 'denied';
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'denied',
      summary: reason,
      inputPreview,
      detailLines: [{ text: reason, op: 'meta' }]
    });
  }
}

export function appendApprovalResult(
  append: (
    from: ChatMessage['from'],
    text: string,
    options?: { expanded?: boolean }
  ) => void,
  result: AgentResult
): void {
  if (result.thinking && result.thinking.trim().length > 0) {
    append('thinking', result.thinking);
  }
  if (result.summary.trim().length > 0) {
    append('agent', result.summary);
  }
}

function formatToolInputPreview(
  toolName: string,
  input: unknown
): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  const preview = formatCoreToolInputPreview(toolName, input, 240);
  return preview.length > 0 ? preview : undefined;
}

function extractLineStats(
  data: unknown,
  summary: string | undefined
): { linesAdded: number; linesRemoved: number } | undefined {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const added = record.linesAdded;
    const removed = record.linesRemoved;
    if (typeof added === 'number' || typeof removed === 'number') {
      return {
        linesAdded: typeof added === 'number' ? added : 0,
        linesRemoved: typeof removed === 'number' ? removed : 0
      };
    }
  }

  if (!summary) {
    return undefined;
  }
  const addedMatch = summary.match(/(?<![.\d])\+(\d+)\b/);
  const removedMatch = summary.match(/(?<![.\d])-(\d+)\b/);
  if (!addedMatch && !removedMatch) {
    return undefined;
  }
  return {
    linesAdded: addedMatch ? Number(addedMatch[1]) : 0,
    linesRemoved: removedMatch ? Number(removedMatch[1]) : 0
  };
}

function buildAwaitingDetail(
  toolName: string,
  inputPreview: string | undefined
): ToolDetailLine[] {
  const lines: ToolDetailLine[] = [{ text: 'awaiting approval', op: 'meta' }];
  if (inputPreview) {
    for (const line of inputPreview.split('\n').slice(0, 6)) {
      lines.push({ text: line, op: 'meta' });
    }
  }
  return lines;
}

function buildRunningDetail(
  toolName: string,
  inputPreview: string | undefined
): ToolDetailLine[] {
  if (!inputPreview) {
    return [{ text: 'running…', op: 'meta' }];
  }
  return inputPreview
    .split('\n')
    .slice(0, 4)
    .map((text) => ({ text, op: 'meta' as const }));
}

function buildCompletedDetail(
  toolName: string,
  data: unknown,
  summary: string | undefined,
  contentPreview: string | undefined,
  inputPreview: string | undefined
): { lines: ToolDetailLine[]; truncated?: boolean } {
  // Delete / Move：极简结果
  if (toolName === 'Delete' || toolName === 'Move') {
    const lines: ToolDetailLine[] = [];
    if (summary) {
      lines.push({ text: summary, op: 'meta' });
    }
    if (inputPreview) {
      lines.push({ text: inputPreview, op: 'meta' });
    }
    return { lines: lines.length > 0 ? lines : [{ text: 'done', op: 'meta' }] };
  }

  // Edit / Write：优先 structured diffPreview
  if (toolName === 'Edit' || toolName === 'Write') {
    const fromData = extractDiffPreview(data);
    if (fromData) {
      return fromData;
    }
    // 回退：从 inputPreview 的 -/+ 行着色
    if (inputPreview) {
      const lines = inputPreview.split('\n').map((line): ToolDetailLine => {
        if (line.startsWith('+')) {
          return { text: line, op: 'add' };
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          return { text: line, op: 'del' };
        }
        return { text: line, op: 'meta' };
      });
      if (lines.length > 0) {
        return { lines: lines.slice(0, 48) };
      }
    }
  }

  // Read：只显示 "read N lines"
  if (toolName === 'Read') {
    return {
      lines: [{ text: summary && summary.length > 0 ? summary : 'read', op: 'meta' }]
    };
  }

  // Glob / Grep / List / Stat / Git*：极简 meta
  if (
    toolName === 'Glob' ||
    toolName === 'Grep' ||
    toolName === 'List' ||
    toolName === 'Stat' ||
    toolName === 'GitStatus' ||
    toolName === 'GitLog'
  ) {
    const lines: ToolDetailLine[] = [];
    if (summary) {
      lines.push({ text: summary, op: 'meta' });
    }
    if (contentPreview && contentPreview !== summary) {
      const maxLines = toolName === 'Glob' || toolName === 'Grep' ? 16 : 10;
      for (const line of contentPreview.split('\n').slice(0, maxLines)) {
        if (line.trim().length === 0) {
          continue;
        }
        // Grep 结果常带 line: 前缀，保留；纯行号样式则剥掉
        const text =
          toolName === 'Grep' ? line : stripLineNumberPrefix(line);
        lines.push({ text: clip(text, 140), op: 'meta' });
      }
      if (contentPreview.split('\n').length > maxLines) {
        lines.push({ text: '… more', op: 'meta' });
      }
    }
    if (lines.length === 0 && inputPreview) {
      lines.push({ text: clip(inputPreview, 120), op: 'meta' });
    }
    return { lines: lines.length > 0 ? lines : [{ text: 'done', op: 'meta' }] };
  }

  // GitDiff：尽量保留补丁着色
  if (toolName === 'GitDiff') {
    return buildPatchStyleDetail(contentPreview, summary, 40);
  }

  // Bash：summary + 输出尾部（更贴近「最后 N 行」）
  if (toolName === 'Bash') {
    const lines: ToolDetailLine[] = [];
    if (summary) {
      lines.push({ text: summary, op: 'meta' });
    }
    if (contentPreview) {
      const raw = contentPreview.split('\n');
      const tail = raw.slice(-20);
      if (raw.length > tail.length) {
        lines.push({
          text: `… ${raw.length - tail.length} lines above`,
          op: 'meta'
        });
      }
      for (const line of tail) {
        lines.push({ text: clip(line, 200), op: 'meta' });
      }
    }
    return {
      lines: lines.length > 0 ? lines : [{ text: 'done', op: 'meta' }]
    };
  }

  // 其它工具：summary + 输出预览
  const lines: ToolDetailLine[] = [];
  if (summary) {
    lines.push({ text: summary, op: 'meta' });
  }
  if (contentPreview) {
    for (const line of contentPreview.split('\n').slice(0, 16)) {
      lines.push({ text: clip(line, 160), op: 'meta' });
    }
  }
  return {
    lines: lines.length > 0 ? lines : [{ text: 'done', op: 'meta' }]
  };
}

/** unified patch / git diff 风格：+/- 行着色 */
function buildPatchStyleDetail(
  contentPreview: string | undefined,
  summary: string | undefined,
  maxLines: number
): { lines: ToolDetailLine[]; truncated?: boolean } {
  const lines: ToolDetailLine[] = [];
  if (summary) {
    lines.push({ text: summary, op: 'meta' });
  }
  if (!contentPreview) {
    return { lines: lines.length > 0 ? lines : [{ text: 'done', op: 'meta' }] };
  }
  const raw = contentPreview.split('\n');
  const body = raw.slice(0, maxLines).map((line): ToolDetailLine => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return { text: clip(line, 200), op: 'add' };
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      return { text: clip(line, 200), op: 'del' };
    }
    return { text: clip(line, 200), op: 'meta' };
  });
  lines.push(...body);
  const truncated = raw.length > maxLines;
  if (truncated) {
    lines.push({ text: `… +${raw.length - maxLines} more lines`, op: 'meta' });
  }
  return { lines, truncated };
}

function extractDiffPreview(
  data: unknown
): { lines: ToolDetailLine[]; truncated?: boolean } | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  const preview = (data as { diffPreview?: unknown }).diffPreview;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    return undefined;
  }
  const record = preview as { lines?: unknown; truncated?: unknown };
  if (!Array.isArray(record.lines)) {
    return undefined;
  }
  const lines: ToolDetailLine[] = [];
  for (const raw of record.lines) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const row = raw as { op?: unknown; text?: unknown };
    if (typeof row.text !== 'string') {
      continue;
    }
    const op: ToolDetailLine['op'] =
      row.op === 'add' ||
      row.op === 'del' ||
      row.op === 'meta' ||
      row.op === 'ctx'
        ? row.op
        : 'meta';
    const lineNo =
      typeof (row as { lineNo?: unknown }).lineNo === 'number'
        ? (row as { lineNo: number }).lineNo
        : undefined;
    lines.push({ text: row.text, op, lineNo });
  }
  if (lines.length === 0) {
    return undefined;
  }
  return {
    lines,
    truncated: record.truncated === true
  };
}

/**
 * 去掉常见行号前缀，Read 展开不展示行号：
 * "  12|code" / "12:code" / "12| code"
 */
function stripLineNumberPrefix(line: string): string {
  return line
    .replace(/^\s*\d+\s*[|:\u2502]\s?/, '')
    .replace(/^\s*\d+\s+/, (match, offset, whole) => {
      // 仅当后面像代码且数字较短时剥掉（避免误伤 "2020 was a year"）
      if (match.trim().length <= 5 && whole.length > match.length) {
        return '';
      }
      return match;
    });
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}
