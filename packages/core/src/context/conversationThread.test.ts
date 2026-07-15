import { describe, expect, it, beforeEach } from 'vitest';

import {
  ConversationThread,
  LEGACY_COMPACTION_MARKER,
  resetThreadCounters
} from './conversationThread';

describe('ConversationThread', () => {
  beforeEach(() => {
    resetThreadCounters();
  });

  it('manages turn lifecycle begin/commit', () => {
    const thread = new ConversationThread();
    thread.beginTurn('hello');
    thread.appendAssistant('hi there');
    thread.commitTurn();

    expect(thread.getOpenTurnId()).toBeUndefined();
    expect(thread.buildMessages()).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' }
    ]);
  });

  it('keeps open turn across partial tool loop (approval suspend)', () => {
    const thread = new ConversationThread();
    thread.beginTurn('write file');
    thread.appendAssistant('calling tool', [
      { id: 'tc1', name: 'Write', input: { path: 'a.txt' } }
    ]);
    expect(thread.getOpenTurnId()).toBeDefined();
    expect(thread.getCommittedEntries()).toHaveLength(0);
  });

  it('abortTurn adds notice and closes turn', () => {
    const thread = new ConversationThread();
    thread.beginTurn('task');
    thread.abortTurn('cancelled');
    expect(thread.getOpenTurnId()).toBeUndefined();
    expect(thread.buildMessages().at(-1)?.content).toContain('cancelled');
  });

  it('restores legacy compaction marker as compaction entry', () => {
    const thread = new ConversationThread();
    const result = thread.restoreFromConversation([
      {
        role: 'assistant',
        content: `${LEGACY_COMPACTION_MARKER}\n早前摘要\n用户曾讨论 Kross\n--- END OF CONTEXT SUMMARY ---`
      },
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '好的' }
    ]);
    expect(result.convertedCompaction).toBe(true);
    const messages = thread.buildMessages();
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toContain('上下文压缩摘要');
    expect(messages[0]?.content).toContain('Kross');
  });

  it('preserves turn atomicity in restore pairs', () => {
    const thread = new ConversationThread();
    thread.restoreFromConversation([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' }
    ]);
    expect(thread.getTurnIdsInOrder()).toHaveLength(2);
  });
});
