import type { AgentHostHandle } from './coreRuntimeFactory';

export interface ConversationRuntimeRequest {
  conversationId: string;
  signature: string;
  history: Array<{ role: string; content: string }>;
  create(): Promise<AgentHostHandle>;
}

interface RuntimeEntry {
  signature: string;
  host: AgentHostHandle;
}

/**
 * Keeps runtime conversation state isolated while bounding long-lived MCP and
 * process resources. Map insertion order is used as a small LRU.
 */
export class ConversationRuntimeRegistry {
  private readonly entries = new Map<string, RuntimeEntry>();

  constructor(private readonly maxEntries = 4) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Conversation runtime registry size must be positive');
    }
  }

  async acquire(request: ConversationRuntimeRequest): Promise<AgentHostHandle> {
    const existing = this.entries.get(request.conversationId);
    if (existing?.signature === request.signature) {
      this.entries.delete(request.conversationId);
      this.entries.set(request.conversationId, existing);
      return existing.host;
    }

    const next = await request.create();
    try {
      next.runtime.restoreConversation(normalizeHistory(request.history));
    } catch (error) {
      await next.close().catch(() => undefined);
      throw error;
    }

    if (existing) {
      this.entries.delete(request.conversationId);
      await existing.host.close().catch(() => undefined);
    }
    this.entries.set(request.conversationId, {
      signature: request.signature,
      host: next
    });
    await this.evictOverflow();
    return next;
  }

  async reloadMcp(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.host.reloadMcp()));
  }

  async close(): Promise<void> {
    const hosts = [...this.entries.values()].map((entry) => entry.host);
    this.entries.clear();
    await Promise.allSettled(hosts.map((host) => host.close()));
  }

  private async evictOverflow(): Promise<void> {
    while (this.entries.size > this.maxEntries) {
      const oldestId = this.entries.keys().next().value as string | undefined;
      if (!oldestId) return;
      const oldest = this.entries.get(oldestId);
      this.entries.delete(oldestId);
      await oldest?.host.close().catch(() => undefined);
    }
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
