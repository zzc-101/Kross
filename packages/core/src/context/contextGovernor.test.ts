import { describe, expect, it } from 'vitest';

import { ContextGovernor } from './contextGovernor';
import { createContextPolicy } from './contextPolicy';
import { ConversationThread } from './conversationThread';
import { ExtractiveSummarizer } from './summarizer';
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

    const beforeCount = thread.getTurnIdsInOrder().length;
    const result = await governor.govern({
      thread,
      threadTokenBudget: 300
    });

    expect(result.maintenance.some((item) => item.stage === 'turn-compaction')).toBe(
      true
    );
    expect(thread.getTurnIdsInOrder().length).toBeLessThan(beforeCount);
    expect(
      thread.buildMessages().some((message) => message.content.includes('压缩摘要'))
    ).toBe(true);
    expect(thread.buildMessages().some((message) => message.content.includes('question 3'))).toBe(
      true
    );
  });
});
