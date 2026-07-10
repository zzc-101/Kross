import type { AgentResult, TraceEvent } from '@kross/core';

import type { ChatMessage, ToolCallState } from '../ui';

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
  const inputPreview = formatToolInputPreview(payload.input);

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
      inputPreview
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
      inputPreview
    });
    return;
  }

  if (event.type === 'tool_call.completed') {
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'completed',
      summary,
      inputPreview,
      durationMs
    });
    return;
  }

  if (event.type === 'tool_call.failed') {
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'failed',
      summary:
        summary ??
        (typeof payload.message === 'string' ? payload.message : 'tool failed'),
      inputPreview,
      durationMs
    });
    return;
  }

  if (event.type === 'tool_call.denied') {
    handlers.upsertToolMessage(key, {
      callId,
      name: toolName,
      risk,
      status: 'denied',
      summary: typeof payload.reason === 'string' ? payload.reason : 'denied',
      inputPreview
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

function formatToolInputPreview(input: unknown): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input === 'string') {
    return input;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
