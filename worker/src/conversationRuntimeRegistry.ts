import type { AgentHostHandle } from './coreRuntimeFactory';

export interface ConversationRuntimeRequest {
  conversationId: string;
  signature: string;
  history: Array<{ role: string; content: string }>;
  create(): Promise<AgentHostHandle>;
}

interface RuntimeEntry {
  conversationId: string;
  signature: string;
  host: AgentHostHandle;
}

/** Keeps one active runtime because the worker processes jobs serially. */
export class ConversationRuntimeRegistry {
  private current?: RuntimeEntry;

  async acquire(request: ConversationRuntimeRequest): Promise<AgentHostHandle> {
    if (
      this.current?.conversationId === request.conversationId
      && this.current.signature === request.signature
    ) {
      return this.current.host;
    }

    const next = await request.create();
    try {
      next.runtime.restoreConversation(normalizeHistory(request.history));
    } catch (error) {
      await next.close().catch(() => undefined);
      throw error;
    }

    const previous = this.current;
    this.current = {
      conversationId: request.conversationId,
      signature: request.signature,
      host: next
    };
    await previous?.host.close().catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    await current?.host.close();
  }
}

function normalizeHistory(
  history: Array<{ role: string; content: string }>
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return history.flatMap((message) => {
    const role = message.role === 'agent' ? 'assistant' : message.role;
    return role === 'user' || role === 'assistant'
      ? [{ role, content: message.content }]
      : [];
  });
}
