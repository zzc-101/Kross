import {
  agentReportSchema,
  t,
  type MessageKey,
  type SessionSummary,
  type StoredSessionMessage
} from '@kross/core';

import type { ChatMessage, ToolCallState } from '../ui';

export function safeListRecentSessions(
  sessionStore:
    | Pick<import('@kross/core').HybridSessionStore, 'listRecent'>
    | undefined,
  cwd: string
): SessionSummary[] {
  if (!sessionStore) {
    return [];
  }
  try {
    return sessionStore.listRecent(cwd, 4);
  } catch {
    return [];
  }
}

export function toStoredSessionMessage(message: ChatMessage): StoredSessionMessage {
  return {
    id: message.id,
    from: message.from,
    text: message.text,
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    ...(message.durationMs !== undefined
      ? { durationMs: message.durationMs }
      : {}),
    ...(message.expanded !== undefined ? { expanded: message.expanded } : {}),
    ...(message.tool ? { tool: message.tool } : {}),
    ...(message.verification ? { verification: message.verification } : {})
  };
}

export function fromStoredSessionMessage(message: StoredSessionMessage): ChatMessage {
  return {
    id: message.id,
    from: message.from,
    text: message.text,
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    ...(message.durationMs !== undefined
      ? { durationMs: message.durationMs }
      : {}),
    ...(message.expanded !== undefined ? { expanded: message.expanded } : {}),
    ...(message.tool && typeof message.tool === 'object'
      ? { tool: message.tool as ToolCallState }
      : {}),
    ...parseVerification(message.verification)
  };
}

function parseVerification(value: unknown): Pick<ChatMessage, 'verification'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const parsed = agentReportSchema.shape.verification.safeParse(value);
  return parsed.success ? { verification: parsed.data } : {};
}

export function formatSessionError(prefixKey: MessageKey, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return t('session.errorDetail', { prefix: t(prefixKey), detail });
}
