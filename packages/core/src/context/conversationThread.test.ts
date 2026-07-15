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

  it('replaces a historical prefix with a summary in chronological position', () => {
    const thread = new ConversationThread();
    thread.beginTurn('old');
    thread.appendAssistant('old answer');
    thread.commitTurn();
    thread.beginTurn('recent');
    thread.appendAssistant('recent answer');
    thread.commitTurn();

    thread.replacePrefixWithCompaction(2, 'old summary');

    const messages = thread.buildMessages();
    expect(messages[0]?.content).toContain('old summary');
    expect(messages[1]?.content).toBe('recent');
    expect(messages[2]?.content).toBe('recent answer');
  });

  it('round-trips a governed thread state', () => {
    const original = new ConversationThread();
    original.addCompaction('earlier decisions');
    original.beginTurn('continue');
    original.appendAssistant('done');
    original.commitTurn();

    const restored = new ConversationThread();
    expect(restored.restoreState(original.exportState())).toBe(true);
    expect(restored.buildMessages()).toEqual(original.buildMessages());
    expect(restored.getOpenTurnId()).toBeUndefined();
  });

  it('aborts an open restored turn and removes unmatched tool calls', () => {
    const original = new ConversationThread();
    original.beginTurn('dangerous write');
    original.appendAssistant('waiting approval', [
      { id: 'pending-1', name: 'Write', input: { path: 'a.ts' } }
    ]);

    const restored = new ConversationThread();
    restored.restoreState(original.exportState());

    const turnId = restored.getTurnIdsInOrder()[0]!;
    expect(restored.getTurnStatus(turnId)).toBe('aborted');
    expect(restored.getOpenTurnId()).toBeUndefined();
    const assistant = restored.buildMessages()[1];
    expect(assistant?.role).toBe('assistant');
    if (assistant?.role === 'assistant') {
      expect(assistant.toolCalls).toBeUndefined();
    }
    expect(restored.buildMessages().at(-1)?.content).toContain('未完成轮次中断');
  });
});
