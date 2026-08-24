import { describe, expect, it, vi } from 'vitest';

import type { AgentHostHandle } from './coreRuntimeFactory';
import { ConversationRuntimeRegistry } from './conversationRuntimeRegistry';

function fakeHost() {
  const restoreConversation = vi.fn();
  const close = vi.fn(async () => undefined);
  const reloadMcp = vi.fn(async () => undefined);
  return {
    host: { runtime: { restoreConversation }, close, reloadMcp } as unknown as AgentHostHandle,
    restoreConversation,
    close,
    reloadMcp
  };
}

describe('ConversationRuntimeRegistry', () => {
  it('isolates conversations and restores role-correct history once', async () => {
    const registry = new ConversationRuntimeRegistry();
    const first = fakeHost();
    const second = fakeHost();

    const a1 = await registry.acquire({
      conversationId: 'a',
      signature: 'model-1',
      history: [
        { role: 'user', content: 'question' },
        { role: 'agent', content: 'answer' }
      ],
      create: async () => first.host
    });
    const a2 = await registry.acquire({
      conversationId: 'a',
      signature: 'model-1',
      history: [],
      create: async () => second.host
    });
    const b = await registry.acquire({
      conversationId: 'b',
      signature: 'model-1',
      history: [],
      create: async () => second.host
    });

    expect(a1).toBe(first.host);
    expect(a2).toBe(first.host);
    expect(b).toBe(second.host);
    expect(first.restoreConversation).toHaveBeenCalledOnce();
    expect(first.restoreConversation).toHaveBeenCalledWith([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' }
    ]);
  });

  it('replaces changed profiles and evicts the least recently used runtime', async () => {
    const registry = new ConversationRuntimeRegistry(2);
    const a1 = fakeHost();
    const a2 = fakeHost();
    const b = fakeHost();
    const c = fakeHost();

    await registry.acquire({ conversationId: 'a', signature: 'v1', history: [], create: async () => a1.host });
    await registry.acquire({ conversationId: 'a', signature: 'v2', history: [], create: async () => a2.host });
    await registry.acquire({ conversationId: 'b', signature: 'v1', history: [], create: async () => b.host });
    await registry.acquire({ conversationId: 'c', signature: 'v1', history: [], create: async () => c.host });

    expect(a1.close).toHaveBeenCalledOnce();
    expect(a2.close).toHaveBeenCalledOnce();
    expect(b.close).not.toHaveBeenCalled();
    expect(c.close).not.toHaveBeenCalled();
  });
});
