import { describe, expect, it } from 'vitest';

import { SessionContext } from './sessionContext';
import { resetThreadCounters } from './conversationThread';

describe('SessionContext', () => {
  it('builds system prompt with tools and sources', async () => {
    resetThreadCounters();
    const ctx = new SessionContext({ contextWindow: 256_000 });
    ctx.addSource({
      id: 'rules',
      kind: 'workspace',
      title: 'Rules',
      content: 'answer in Chinese',
      priority: 10
    });

    const prepared = await ctx.prepareRequest({
      systemPrompt: '你是 Kross',
      mode: 'normal',
      tools: [
        {
          name: 'Read',
          description: '读文件',
          risk: 'read'
        }
      ]
    });

    expect(prepared.messages[0]?.content).toContain('你是 Kross');
    expect(prepared.messages[0]?.content).toContain('Read');
    expect(prepared.messages[0]?.content).toContain('Rules');
    expect(prepared.includedSources).toContain('rules');
  });

  it('snapshot is read-only and does not record maintenance', async () => {
    resetThreadCounters();
    const ctx = new SessionContext({ contextWindow: 4_000 });
    ctx.beginTurn('hello');
    ctx.appendAssistant('world '.repeat(200));
    ctx.commitTurn();

    const before = ctx.getAllMaintenance().length;
    const snap1 = ctx.snapshot({
      systemPrompt: 'sys',
      mode: 'normal'
    });
    const snap2 = ctx.snapshot({
      systemPrompt: 'sys',
      mode: 'normal'
    });
    expect(ctx.getAllMaintenance().length).toBe(before);
    expect(snap1.estimatedTokens).toBe(snap2.estimatedTokens);
  });

  it('keeps pinned sources when budget is tight', async () => {
    resetThreadCounters();
    const ctx = new SessionContext({ contextWindow: 500 });
    ctx.addSource({
      id: 'session-todos',
      kind: 'user',
      title: 'Todos',
      content: 'must keep',
      pinned: true
    });
    ctx.addSource({
      id: 'low',
      kind: 'workspace',
      title: 'Low',
      content: 'x'.repeat(2000),
      priority: 1
    });

    const snap = ctx.snapshot({
      systemPrompt: 'sys',
      mode: 'normal'
    });
    expect(snap.includedSources).toContain('session-todos');
    expect(snap.droppedSources).toContain('low');
  });

  it('getCommittedDialog excludes open turn', () => {
    resetThreadCounters();
    const ctx = new SessionContext();
    ctx.beginTurn('pending');
    ctx.appendAssistant('partial');
    expect(ctx.getCommittedDialog()).toHaveLength(0);

    ctx.commitTurn();
    expect(ctx.getCommittedDialog()).toEqual([
      { role: 'user', content: 'pending' },
      { role: 'assistant', content: 'partial' }
    ]);
  });
});
