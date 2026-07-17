import type { TraceEvent } from '../domain';

export interface RunToolStats {
  total: number;
  completed: number;
  failed: number;
  approvalRequired: number;
  denied: number;
  rejected: number;
}

export interface RunTraceToolLine {
  toolName: string;
  status:
    | 'started'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'approval_required'
    | 'denied'
    | 'rejected';
  summary?: string;
  durationMs?: number;
  callId?: string;
}

export interface RunTraceSummary {
  runId: string;
  eventCount: number;
  startedAt?: string;
  endedAt?: string;
  status: string;
  mode?: string;
  inputPreview?: string;
  summaryPreview?: string;
  tools: string[];
  toolStats: RunToolStats;
  flags: string[];
  failureMessage?: string;
}

export interface RunTraceDetail extends RunTraceSummary {
  toolLines: RunTraceToolLine[];
  highlights: Array<{ type: string; detail: string; timestamp: string }>;
}

const EMPTY_TOOL_STATS: RunToolStats = {
  total: 0,
  completed: 0,
  failed: 0,
  approvalRequired: 0,
  denied: 0,
  rejected: 0
};

/** 终态：后续 awaiting_approval 不得再覆盖。 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * 从单次 run 的 events 汇总调试视图。
 * 无事件时返回 null（run 不存在或目录为空）。
 */
export function summarizeTraceEvents(
  runId: string,
  events: TraceEvent[]
): RunTraceSummary | null {
  if (events.length === 0) {
    return null;
  }

  const toolStats: RunToolStats = { ...EMPTY_TOOL_STATS };
  const toolNames = new Set<string>();
  const flags = new Set<string>();
  let status = 'running';
  let mode: string | undefined;
  let inputPreview: string | undefined;
  let summaryPreview: string | undefined;
  let failureMessage: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;

  for (const event of events) {
    if (!startedAt || event.timestamp < startedAt) {
      startedAt = event.timestamp;
    }
    if (!endedAt || event.timestamp > endedAt) {
      endedAt = event.timestamp;
    }

    switch (event.type) {
      case 'run.started': {
        inputPreview = previewText(asString(event.payload.input), 80);
        break;
      }
      case 'mode.detected': {
        mode = asString(event.payload.mode) ?? mode;
        break;
      }
      case 'run.completed': {
        status = asString(event.payload.status) ?? 'completed';
        mode = asString(event.payload.mode) ?? mode;
        summaryPreview = previewText(asString(event.payload.summary), 120);
        const report = asRecord(event.payload.report);
        const verification = asRecord(report?.verification);
        const verificationStatus = asString(verification?.status);
        if (verificationStatus) {
          flags.add(`verification-${verificationStatus}`);
          if (verificationStatus === 'failed') {
            failureMessage =
              asString(verification?.reason) ??
              'verification command failed';
          }
        }
        break;
      }
      case 'review.completed': {
        // 旧 trace 兼容：新 normal 路径不再写入 review.completed
        if (!summaryPreview) {
          summaryPreview = previewText(asString(event.payload.summary), 120);
        }
        if (!TERMINAL_STATUSES.has(status)) {
          status = asString(event.payload.status) ?? status;
        }
        break;
      }
      case 'run.awaiting_approval': {
        // 仅非终态时更新，避免乱序/补写事件把已完成 run 盖成审批中
        if (!TERMINAL_STATUSES.has(status)) {
          status = 'approval-required';
        }
        flags.add('awaiting-tool-approval');
        break;
      }
      case 'run.interrupted': {
        flags.add('interrupted');
        break;
      }
      case 'approval.required': {
        flags.add('plan-approval');
        break;
      }
      case 'llm.planner.failed': {
        if (!TERMINAL_STATUSES.has(status)) {
          status = 'failed';
        }
        failureMessage = asString(event.payload.message) ?? failureMessage;
        flags.add('planner-failed');
        break;
      }
      case 'llm.tool_loop.max_iterations': {
        flags.add('max-iterations');
        break;
      }
      case 'llm.tool_loop.stall_detected': {
        flags.add('stall-detected');
        break;
      }
      case 'llm.tool_loop.stall_recovery': {
        flags.add('stall-recovery');
        break;
      }
      case 'llm.tool_loop.stalled': {
        flags.add('stalled');
        failureMessage = 'tool loop repeated without progress';
        break;
      }
      case 'context.built': {
        flags.add('context-built');
        break;
      }
      case 'tool_call.started': {
        toolStats.total += 1;
        addToolName(toolNames, event.payload.toolName);
        break;
      }
      case 'tool_call.completed': {
        toolStats.completed += 1;
        addToolName(toolNames, event.payload.toolName);
        break;
      }
      case 'tool_call.failed': {
        toolStats.failed += 1;
        addToolName(toolNames, event.payload.toolName);
        failureMessage =
          asString(event.payload.message) ??
          asString(event.payload.summary) ??
          failureMessage;
        flags.add('tool-failed');
        break;
      }
      case 'tool_call.approval_required': {
        toolStats.approvalRequired += 1;
        addToolName(toolNames, event.payload.toolName);
        flags.add('tool-approval');
        break;
      }
      case 'tool_call.denied': {
        toolStats.denied += 1;
        addToolName(toolNames, event.payload.toolName);
        flags.add('tool-denied');
        break;
      }
      case 'tool_call.rejected': {
        toolStats.rejected += 1;
        addToolName(toolNames, event.payload.toolName);
        flags.add('tool-rejected');
        break;
      }
      case 'tool_call.cancelled': {
        addToolName(toolNames, event.payload.toolName);
        flags.add('tool-cancelled');
        break;
      }
      default:
        break;
    }
  }

  // started 可能缺失；total 取 max(started, finished, 审批相关 pre-start 计数)
  const finished = toolStats.completed + toolStats.failed;
  const preStart =
    toolStats.approvalRequired + toolStats.denied + toolStats.rejected;
  toolStats.total = Math.max(toolStats.total, finished, preStart);

  return {
    runId,
    eventCount: events.length,
    startedAt,
    endedAt,
    status,
    mode,
    inputPreview,
    summaryPreview,
    tools: [...toolNames],
    toolStats,
    flags: [...flags],
    failureMessage
  };
}

export function buildTraceDetail(
  runId: string,
  events: TraceEvent[]
): RunTraceDetail | null {
  const summary = summarizeTraceEvents(runId, events);
  if (!summary) {
    return null;
  }

  const toolLines: RunTraceToolLine[] = [];
  const highlights: RunTraceDetail['highlights'] = [];

  for (const event of events) {
    if (event.type.startsWith('tool_call.')) {
      const toolName = asString(event.payload.toolName) ?? 'unknown';
      const status = event.type.slice('tool_call.'.length) as RunTraceToolLine['status'];
      toolLines.push({
        toolName,
        status,
        summary:
          asString(event.payload.summary) ??
          asString(event.payload.message) ??
          asString(event.payload.reason),
        durationMs: asNumber(event.payload.durationMs),
        callId: asString(event.payload.callId)
      });
    }

    if (isHighlightType(event.type)) {
      highlights.push({
        type: event.type,
        detail: highlightDetail(event),
        timestamp: event.timestamp
      });
    }
  }

  return {
    ...summary,
    toolLines,
    highlights
  };
}

export function formatTraceList(
  summaries: RunTraceSummary[],
  options: { limit?: number } = {}
): string {
  const limit = options.limit ?? 10;
  if (summaries.length === 0) {
    return [
      '最近运行：无',
      '提示：完成一次 agent 任务后，trace 会写入 runs/<runId>/events.jsonl',
      '用法：/trace · /trace <runId>'
    ].join('\n');
  }

  const lines = summaries.slice(0, limit).map((item, index) => {
    const tools =
      item.toolStats.total > 0
        ? `${item.toolStats.total} tools`
        : '0 tools';
    const mode = item.mode ?? '-';
    const input = item.inputPreview ?? '(no input)';
    const flagSuffix =
      item.flags.length > 0 ? ` · ${item.flags.slice(0, 3).join(',')}` : '';
    return `${index + 1}. ${item.runId}  ${item.status}  ${mode}  ${tools}${flagSuffix}\n   ${input}`;
  });

  return [
    `最近 ${Math.min(limit, summaries.length)} 次运行：`,
    ...lines,
    '用法：/trace <runId> 查看详情'
  ].join('\n');
}

export function formatTraceDetail(detail: RunTraceDetail): string {
  const toolStatParts = [
    `total=${detail.toolStats.total}`,
    `ok=${detail.toolStats.completed}`,
    `fail=${detail.toolStats.failed}`,
    `ask=${detail.toolStats.approvalRequired}`,
    `deny=${detail.toolStats.denied}`,
    `reject=${detail.toolStats.rejected}`
  ];

  const toolLines =
    detail.toolLines.length > 0
      ? detail.toolLines
          .slice(-12)
          .map((line) => {
            const dur =
              line.durationMs !== undefined ? ` ${line.durationMs}ms` : '';
            const note = line.summary ? ` — ${previewText(line.summary, 80)}` : '';
            return `- ${line.toolName} ${line.status}${dur}${note}`;
          })
          .join('\n')
      : '- (no tool calls)';

  const highlightLines =
    detail.highlights.length > 0
      ? detail.highlights
          .slice(-10)
          .map((item) => `- ${item.type}: ${item.detail}`)
          .join('\n')
      : '- (none)';

  return [
    `Trace: ${detail.runId}`,
    `status: ${detail.status} · mode: ${detail.mode ?? '-'} · events: ${detail.eventCount}`,
    `time: ${detail.startedAt ?? '-'} → ${detail.endedAt ?? '-'}`,
    `input: ${detail.inputPreview ?? '(none)'}`,
    `summary: ${detail.summaryPreview ?? '(none)'}`,
    `tools: ${toolStatParts.join(' · ')}`,
    detail.tools.length > 0 ? `used: ${detail.tools.join(', ')}` : 'used: (none)',
    detail.flags.length > 0 ? `flags: ${detail.flags.join(', ')}` : 'flags: (none)',
    detail.failureMessage
      ? `failure: ${previewText(detail.failureMessage, 160)}`
      : undefined,
    'tool calls:',
    toolLines,
    'highlights:',
    highlightLines
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function addToolName(set: Set<string>, value: unknown): void {
  const name = asString(value);
  if (name) {
    set.add(name);
  }
}

function isHighlightType(type: string): boolean {
  return (
    type === 'tool_call.failed' ||
    type === 'tool_call.cancelled' ||
    type === 'tool_call.approval_required' ||
    type === 'tool_call.denied' ||
    type === 'tool_call.rejected' ||
    type === 'llm.tool_loop.max_iterations' ||
    type === 'llm.tool_loop.stall_detected' ||
    type === 'llm.tool_loop.stall_recovery' ||
    type === 'llm.tool_loop.stalled' ||
    type === 'llm.planner.failed' ||
    type === 'approval.required' ||
    type === 'run.awaiting_approval' ||
    type === 'run.interrupted' ||
    type === 'context.built'
  );
}

function highlightDetail(event: TraceEvent): string {
  switch (event.type) {
    case 'tool_call.failed':
      return `${asString(event.payload.toolName) ?? '?'} — ${
        asString(event.payload.message) ?? asString(event.payload.summary) ?? 'failed'
      }`;
    case 'tool_call.cancelled':
      return `${asString(event.payload.toolName) ?? '?'} — ${
        asString(event.payload.message) ?? 'cancelled'
      }`;
    case 'tool_call.approval_required':
      return `${asString(event.payload.toolName) ?? '?'} (${asString(event.payload.risk) ?? '?'})`;
    case 'tool_call.denied':
    case 'tool_call.rejected':
      return `${asString(event.payload.toolName) ?? '?'} — ${
        asString(event.payload.reason) ?? event.type
      }`;
    case 'llm.tool_loop.max_iterations':
      return 'tool loop hit max iterations';
    case 'llm.tool_loop.stall_detected':
      return `${asString(event.payload.signaturePreview) ?? 'tool batch'} — repeated without progress`;
    case 'llm.tool_loop.stall_recovery':
      return `${asString(event.payload.signaturePreview) ?? 'tool batch'} — recovery requested`;
    case 'llm.tool_loop.stalled':
      return `${asString(event.payload.signaturePreview) ?? 'tool batch'} — stopped after recovery`;
    case 'llm.planner.failed':
      return asString(event.payload.message) ?? 'planner failed';
    case 'approval.required':
      return asString(event.payload.reason) ?? asString(event.payload.scope) ?? 'plan approval';
    case 'run.awaiting_approval':
      return 'waiting for tool approval';
    case 'run.interrupted':
      return `${asString(event.payload.stage) ?? '?'} — ${
        asString(event.payload.reason) ?? 'interrupted'
      }`;
    case 'context.built': {
      const chars = asNumber(event.payload.estimatedChars);
      const included = Array.isArray(event.payload.includedSources)
        ? event.payload.includedSources.length
        : undefined;
      const parts = [
        chars !== undefined ? `${chars} chars` : undefined,
        included !== undefined ? `${included} sources` : undefined
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : 'built';
    }
    default:
      return event.type;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function previewText(value: string | undefined, max: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= max) {
    return singleLine;
  }
  return `${singleLine.slice(0, max - 1)}…`;
}
