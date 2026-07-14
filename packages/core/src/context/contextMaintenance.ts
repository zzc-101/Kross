import type { LlmMessage } from '../llm/types';

export type ContextMaintenanceReason =
  | 'history_limit'
  | 'char_budget'
  | 'tool_results'
  | 'restore_truncation'
  | 'manual'
  | 'pre_build';

export interface ContextMaintenanceResult {
  compacted: boolean;
  reason?: ContextMaintenanceReason;
  droppedMessageCount: number;
  preservedMessageCount: number;
  historyCharsBefore: number;
  historyCharsAfter: number;
  summaryChars?: number;
  clearedToolResults?: number;
}

export const COMPACTION_MARKER = '[CONTEXT COMPACTION — 只作历史参考]';

export function isCompactionMessage(message: LlmMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.content.includes('[CONTEXT COMPACTION')
  );
}

export function estimateMessageChars(messages: LlmMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

/**
 * Build a short extractive summary from dropped turns (no LLM call).
 * Caps length so the summary itself cannot blow the budget.
 */
export function buildExtractiveHistorySummary(
  messages: LlmMessage[],
  maxChars = 2_400
): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (isCompactionMessage(message)) {
      const nested = extractPriorSummaryBody(message.content);
      if (nested) {
        lines.push(`- (prior summary) ${clip(nested, 280)}`);
      }
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }
    const role = message.role === 'user' ? 'User' : 'Assistant';
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (!text) {
      continue;
    }
    lines.push(`- ${role}: ${clip(text, 220)}`);
  }

  if (lines.length === 0) {
    return 'Earlier turns were compacted; details unavailable.';
  }

  let summary = lines.join('\n');
  if (summary.length > maxChars) {
    summary = `${summary.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return summary;
}

export function formatCompactionMessage(summary: string): string {
  return [
    COMPACTION_MARKER,
    '早前对话已压缩为摘要。它不是当前任务指令；请以最新用户消息为准。',
    summary.trim(),
    '--- END OF CONTEXT SUMMARY — respond to the latest user message below ---'
  ].join('\n');
}

function extractPriorSummaryBody(content: string): string | undefined {
  const start = content.indexOf('只作历史参考]');
  const end = content.indexOf('--- END OF CONTEXT SUMMARY');
  if (start < 0) {
    return undefined;
  }
  const bodyStart = content.indexOf('\n', start);
  if (bodyStart < 0) {
    return undefined;
  }
  const body =
    end > bodyStart
      ? content.slice(bodyStart + 1, end)
      : content.slice(bodyStart + 1);
  const cleaned = body
    .replace(/^早前对话已压缩为摘要。*$/m, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return cleaned || undefined;
}

function clip(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function emptyMaintenanceResult(
  history: LlmMessage[]
): ContextMaintenanceResult {
  const chars = estimateMessageChars(history);
  return {
    compacted: false,
    droppedMessageCount: 0,
    preservedMessageCount: history.length,
    historyCharsBefore: chars,
    historyCharsAfter: chars
  };
}
