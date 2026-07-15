import { describe, expect, it } from 'vitest';

import type { LlmClient } from '../llm/types';
import { createContextPolicy } from './contextPolicy';
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

  it('does not report the previous thread as dropped restore history', () => {
    resetThreadCounters();
    const ctx = new SessionContext();
    ctx.beginTurn('old question');
    ctx.appendAssistant('old answer');
    ctx.commitTurn();

    const result = ctx.restoreConversation([
      { role: 'user', content: 'restored question' },
      { role: 'assistant', content: 'restored answer' }
    ]);

    expect(result.compacted).toBe(false);
    expect(result.droppedMessageCount).toBe(0);
    expect(ctx.getAllMaintenance()).toEqual([]);
    expect(ctx.getCommittedDialog()).toEqual([
      { role: 'user', content: 'restored question' },
      { role: 'assistant', content: 'restored answer' }
    ]);
  });

  it('uses the latest LLM client for manual compaction', async () => {
    resetThreadCounters();
    const calls: string[] = [];
    const ctx = new SessionContext({
      llmClient: summarizingClient('old', calls),
      policy: createContextPolicy({
        contextWindow: 10_000,
        preserveFullTurns: 1
      })
    });
    for (let index = 1; index <= 2; index += 1) {
      ctx.beginTurn(`question ${index}`);
      ctx.appendAssistant(`answer ${index}`);
      ctx.commitTurn();
    }

    ctx.setLlmClient(summarizingClient('new', calls));
    const result = await ctx.compactNow({
      systemPrompt: 'sys',
      mode: 'normal'
    });

    expect(result.compacted).toBe(true);
    expect(calls).toEqual(['new']);
  });

  it('re-estimates existing thread entries after usage calibration', () => {
    resetThreadCounters();
    const ctx = new SessionContext();
    ctx.beginTurn('x'.repeat(400));
    ctx.appendAssistant('y'.repeat(400));
    ctx.commitTurn();
    const messages = ctx.getThread().buildMessages();
    const before = ctx
      .getThread()
      .getEntries()
      .reduce((sum, entry) => sum + entry.tokensEst, 0);

    ctx.calibrateFromUsage(before * 2, messages);

    const after = ctx
      .getThread()
      .getEntries()
      .reduce((sum, entry) => sum + entry.tokensEst, 0);
    expect(after).toBeGreaterThan(before);

    ctx.resetCalibration();
    const reset = ctx
      .getThread()
      .getEntries()
      .reduce((sum, entry) => sum + entry.tokensEst, 0);
    expect(reset).toBe(before);
  });

  it('calibrates against the raw estimate instead of an adjusted estimate', () => {
    resetThreadCounters();
    const ctx = new SessionContext();
    ctx.beginTurn('x'.repeat(400));
    ctx.appendAssistant('y'.repeat(400));
    ctx.commitTurn();
    const messages = ctx.getThread().buildMessages();
    const rawEstimate = ctx.getEstimator().estimate(messages);

    for (let index = 0; index < 30; index += 1) {
      ctx.calibrateFromUsage(rawEstimate * 2, messages);
    }

    expect(ctx.getEstimator().getCalibrationFactor()).toBeCloseTo(2, 2);
  });

  it('restores the exact compacted context instead of rebuilding visible dialog', async () => {
    resetThreadCounters();
    const original = new SessionContext({
      policy: createContextPolicy({ contextWindow: 10_000, preserveFullTurns: 1 })
    });
    for (let index = 1; index <= 3; index += 1) {
      original.beginTurn(`question ${index}`);
      original.appendAssistant(`answer ${index}`);
      original.commitTurn();
    }
    await original.compactNow({ systemPrompt: 'sys', mode: 'normal' });

    const restored = new SessionContext();
    expect(restored.restoreState(original.exportState())).toBe(true);
    expect(restored.getThread().buildMessages()).toEqual(
      original.getThread().buildMessages()
    );
    expect(
      restored.getThread().getEntries().filter((entry) => entry.kind === 'compaction')
    ).toHaveLength(1);
    expect(restored.getAllMaintenance()).toHaveLength(1);
    expect(restored.getLastMaintenance()?.reason).toBe('manual');
  });

  it('keeps a dedicated summarizer client when the runtime model changes', async () => {
    resetThreadCounters();
    const calls: string[] = [];
    const ctx = new SessionContext({
      llmClient: summarizingClient('runtime', calls),
      summarizerClient: summarizingClient('dedicated', calls),
      policy: createContextPolicy({ contextWindow: 10_000, preserveFullTurns: 1 })
    });
    for (let index = 1; index <= 2; index += 1) {
      ctx.beginTurn(`question ${index}`);
      ctx.appendAssistant(`answer ${index}`);
      ctx.commitTurn();
    }
    ctx.setLlmClient(summarizingClient('new-runtime', calls));

    await ctx.compactNow(
      { systemPrompt: 'sys', mode: 'normal' },
      '保留精确路径'
    );
    expect(calls).toEqual(['dedicated']);
  });
});

function summarizingClient(label: string, calls: string[]): LlmClient {
  return {
    provider: 'openai',
    async complete() {
      calls.push(label);
      return {
        provider: 'openai',
        model: label,
        text: `${label} summary`,
        raw: {}
      };
    },
    async *stream() {
      yield { type: 'done' } as const;
    }
  };
}
