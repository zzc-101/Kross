import { describe, expect, it } from 'vitest';

import { ContextGovernor } from './contextGovernor';
import { createContextPolicy } from './contextPolicy';
import { ConversationThread } from './conversationThread';
import { ExtractiveSummarizer } from './summarizer';
import type { SummarizeOptions, SummarizeTurnInput, Summarizer } from './summarizer';
import { TokenEstimator } from './tokenEstimator';

describe('ContextGovernor', () => {
  it('ages old tool results while keeping tool messages for pairing', async () => {
    const estimator = new TokenEstimator();
    const thread = new ConversationThread({ estimator });
    const policy = createContextPolicy({
      contextWindow: 4_000,
      preserveToolIterations: 1,
      maxToolResultTokens: 100
    });
    const governor = new ContextGovernor({
      policy,
      estimator,
      summarizer: new ExtractiveSummarizer()
    });

    thread.beginTurn('run tools');
    thread.setCurrentIteration(1);
    thread.appendAssistant('read', [{ id: 't1', name: 'Read', input: {} }]);
    thread.appendToolResult({
      toolCallId: 't1',
      name: 'Read',
      content: 'OLD '.repeat(500),
      iteration: 1
    });
    thread.setCurrentIteration(2);
    thread.appendAssistant('read again', [{ id: 't2', name: 'Read', input: {} }]);
    thread.appendToolResult({
      toolCallId: 't2',
      name: 'Read',
      content: 'NEW content',
      iteration: 2
    });
    thread.commitTurn();

    const result = await governor.govern({
      thread,
      threadTokenBudget: 200
    });

    expect(result.maintenance.some((item) => item.stage === 'tool-aging')).toBe(
      true
    );
    const toolMessages = thread
      .buildMessages()
      .filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain('已省略');
    expect(toolMessages[1]?.content).toBe('NEW content');
  });

  it('compacts oldest turns atomically', async () => {
    const estimator = new TokenEstimator();
    const thread = new ConversationThread({ estimator });
    const policy = createContextPolicy({
      contextWindow: 2_000,
      preserveFullTurns: 1
    });
    const governor = new ContextGovernor({
      policy,
      estimator,
      summarizer: new ExtractiveSummarizer()
    });

    for (let i = 1; i <= 3; i += 1) {
      thread.beginTurn(`question ${i}`);
      thread.appendAssistant(`answer ${i} `.repeat(80));
      thread.commitTurn();
    }

    const result = await governor.govern({
      thread,
      threadTokenBudget: 300
    });

    expect(result.maintenance.some((item) => item.stage === 'turn-compaction')).toBe(
      true
    );
    expect(thread.getEntries().filter((entry) => entry.kind === 'compaction')).toHaveLength(1);
    expect(
      thread
        .getEntries()
        .some(
          (entry) => entry.kind === 'user' && entry.message.content === 'question 1'
        )
    ).toBe(false);
    expect(
      thread.buildMessages().some((message) => message.content.includes('压缩摘要'))
    ).toBe(true);
    expect(thread.buildMessages().some((message) => message.content.includes('question 3'))).toBe(
      true
    );
    expect(thread.getEntries()[0]?.kind).toBe('compaction');
  });

  it('merges the previous summary and keeps exactly one rolling summary', async () => {
    const estimator = new TokenEstimator();
    const thread = new ConversationThread({ estimator });
    const calls: SummarizeOptions[] = [];
    const summarizer: Summarizer = {
      async summarizeTurns(_turns, options = {}) {
        calls.push(options);
        return options.previousSummary ? 'merged summary' : 'first summary';
      }
    };
    const governor = new ContextGovernor({
      policy: createContextPolicy({ contextWindow: 10_000, preserveFullTurns: 1 }),
      estimator,
      summarizer
    });

    addTurns(thread, 3);
    await governor.compactTurnsNow(thread);
    addTurns(thread, 2, 4);
    await governor.compactTurnsNow(thread);

    expect(calls[1]?.previousSummary).toContain('first summary');
    expect(thread.getEntries().filter((entry) => entry.kind === 'compaction')).toHaveLength(1);
    expect(thread.getEntries()[0]?.message.content).toContain('merged summary');
  });

  it('uses a token tail and safely splits an oversized committed turn', async () => {
    const estimator = new TokenEstimator();
    const thread = new ConversationThread({ estimator });
    const summarizer: Summarizer = {
      async summarizeTurns(turns: SummarizeTurnInput[]) {
        expect(turns[0]?.entries[0]?.kind).toBe('user');
        return 'large user input summarized';
      }
    };
    const governor = new ContextGovernor({
      policy: createContextPolicy({
        contextWindow: 4_000,
        preserveFullTurns: 4,
        preserveRecentTokens: 100
      }),
      estimator,
      summarizer
    });

    thread.beginTurn('U'.repeat(2_000));
    thread.appendAssistant('calling tool', [
      { id: 'call-1', name: 'Read', input: { path: 'a.ts' } }
    ]);
    thread.appendToolResult({
      toolCallId: 'call-1',
      name: 'Read',
      content: 'small result'
    });
    thread.commitTurn();

    const result = await governor.govern({ thread, threadTokenBudget: 180 });

    expect(result.maintenance.some((item) => item.stage === 'turn-compaction')).toBe(true);
    expect(thread.getEntries().map((entry) => entry.kind)).toEqual([
      'compaction',
      'assistant',
      'tool-result'
    ]);
    const messages = thread.buildMessages();
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[2]?.role).toBe('tool');
  });

  it('compacts an oversized older turn when the recent turn fits the token tail', async () => {
    const estimator = new TokenEstimator();
    const thread = new ConversationThread({ estimator });
    const governor = new ContextGovernor({
      policy: createContextPolicy({
        contextWindow: 4_000,
        preserveFullTurns: 4,
        preserveRecentTokens: 100
      }),
      estimator,
      summarizer: {
        async summarizeTurns() {
          return 'old large turn summarized';
        }
      }
    });

    thread.beginTurn('old question');
    thread.appendAssistant(`old answer ${'large '.repeat(500)}`);
    thread.commitTurn();
    thread.beginTurn('recent question');
    thread.appendAssistant('recent answer');
    thread.commitTurn();

    const result = await governor.govern({ thread, threadTokenBudget: 180 });

    expect(result.maintenance.some((item) => item.stage === 'turn-compaction')).toBe(true);
    expect(result.maintenance.some((item) => item.stage === 'hard-truncation')).toBe(false);
    expect(thread.getEntries().map((entry) => entry.kind)).toEqual([
      'compaction',
      'user',
      'assistant'
    ]);
    expect(thread.buildMessages().at(-1)?.content).toBe('recent answer');
  });

  it('never compacts an open turn when manual preserveFullTurns is zero', async () => {
    const estimator = new TokenEstimator();
    const thread = new ConversationThread({ estimator });
    const governor = new ContextGovernor({
      policy: createContextPolicy({ contextWindow: 4_000, preserveFullTurns: 0 }),
      estimator,
      summarizer: {
        async summarizeTurns() {
          return 'committed history summarized';
        }
      }
    });

    thread.beginTurn('committed question');
    thread.appendAssistant('committed answer');
    thread.commitTurn();
    const openTurnId = thread.beginTurn('still running');

    await governor.compactTurnsNow(thread);

    expect(thread.getOpenTurnId()).toBe(openTurnId);
    expect(thread.getEntriesForTurn(openTurnId).map((entry) => entry.message.content)).toEqual([
      'still running'
    ]);
    expect(thread.getEntries()[0]?.kind).toBe('compaction');
  });

  it('keeps a bounded single summary during a long conversation', async () => {
    const estimator = new TokenEstimator();
    const thread = new ConversationThread({ estimator });
    let summaryVersion = 0;
    const summarizer: Summarizer = {
      async summarizeTurns(_turns, options = {}) {
        summaryVersion += 1;
        return `rolling-${summaryVersion}; prior=${options.previousSummary ?? 'none'}`;
      }
    };
    const governor = new ContextGovernor({
      policy: createContextPolicy({
        contextWindow: 4_000,
        preserveRecentTokens: 180
      }),
      estimator,
      summarizer
    });

    for (let index = 1; index <= 40; index += 1) {
      thread.beginTurn(`question ${index}`);
      thread.appendAssistant(`answer ${index} ${'detail '.repeat(80)}`);
      thread.commitTurn();
      await governor.govern({ thread, threadTokenBudget: 420 });
    }

    expect(summaryVersion).toBeGreaterThan(1);
    expect(thread.getEntries().filter((entry) => entry.kind === 'compaction')).toHaveLength(1);
    expect(thread.getEntries().length).toBeLessThan(10);
    expect(
      thread
        .getEntries()
        .some(
          (entry) =>
            entry.kind === 'assistant' && entry.message.content.includes('answer 40')
        )
    ).toBe(true);
  });
});

function addTurns(thread: ConversationThread, count: number, start = 1): void {
  for (let index = start; index < start + count; index += 1) {
    thread.beginTurn(`question ${index}`);
    thread.appendAssistant(`answer ${index}`);
    thread.commitTurn();
  }
}
