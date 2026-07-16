import { describe, expect, it, vi } from 'vitest';

import type { AgentRunStreamEvent } from '@kross/core';

import { consumeAgentStream } from './agentStreamConsumer';

async function* events(
  items: AgentRunStreamEvent[]
): AsyncIterable<AgentRunStreamEvent> {
  for (const item of items) {
    yield item;
  }
}

function createDeps() {
  const messages: Array<{
    from: string;
    text: string;
    durationMs?: number;
  }> = [];
  let nextId = 1;
  const awaiting: boolean[] = [];
  const variants: string[] = [];
  const streamingIds: Array<number | undefined> = [];

  const deps = {
    append: (
      from: 'user' | 'agent' | 'system' | 'tool' | 'thinking',
      text: string,
      options?: { durationMs?: number }
    ) => {
      const id = nextId++;
      messages.push({
        from,
        text,
        durationMs: options?.durationMs
      });
      return id;
    },
    enqueueMessageUpdate: vi.fn(),
    flushMessageUpdates: vi.fn(),
    finalizeThinkingDurations: vi.fn(),
    setAwaitingReply: (value: boolean) => {
      awaiting.push(value);
    },
    setLoadingVariant: (variant: 'thinking' | 'tool') => {
      variants.push(variant);
    },
    setStreamingMessageId: (id: number | undefined) => {
      streamingIds.push(id);
    }
  };

  return { deps, messages, awaiting, variants, streamingIds };
}

describe('consumeAgentStream thinking (Claude Code style)', () => {
  it('keeps awaitingReply true while buffering thinking deltas', async () => {
    const { deps, messages, awaiting } = createDeps();

    const result = await consumeAgentStream(
      events([
        { type: 'turn-start', iteration: 1 },
        { type: 'thinking-delta', text: '先' },
        { type: 'thinking-delta', text: '想' },
        { type: 'text-delta', text: '答案' },
        {
          type: 'result',
          result: {
            runId: 'r1',
            mode: 'auto',
            status: 'completed',
            summary: '答案',
            report: {
              changedFiles: [],
              evidence: [],
              risks: []
            }
          }
        }
      ]),
      deps
    );

    expect(result.sawAgentText).toBe(true);
    // thinking 期间不应把 awaiting 打成 false（turn-start 为 true，text 才 false）
    const firstFalse = awaiting.indexOf(false);
    expect(firstFalse).toBeGreaterThan(-1);
    // false 之前应有 true（turn-start）
    expect(awaiting.slice(0, firstFalse).every((v) => v === true)).toBe(true);

    // thinking 整块一次落下，带 durationMs；随后 agent 流式
    expect(messages.map((m) => m.from)).toEqual(['thinking', 'agent']);
    expect(messages[0]?.text).toBe('先想');
    expect(typeof messages[0]?.durationMs).toBe('number');
    expect(messages[1]?.text).toBe('答案');
  });

  it('commits thinking before tools-start without agent text', async () => {
    const { deps, messages, variants } = createDeps();

    await consumeAgentStream(
      events([
        { type: 'turn-start', iteration: 1 },
        { type: 'thinking-delta', text: '准备读文件' },
        { type: 'tools-start', iteration: 1, count: 1 },
        {
          type: 'result',
          result: {
            runId: 'r2',
            mode: 'auto',
            status: 'completed',
            summary: 'done',
            report: {
              changedFiles: [],
              evidence: [],
              risks: []
            }
          }
        }
      ]),
      deps
    );

    expect(messages).toEqual([
      expect.objectContaining({
        from: 'thinking',
        text: '准备读文件'
      })
    ]);
    expect(variants).toContain('tool');
  });

  it('does not create a thinking bubble when there is no thinking', async () => {
    const { deps, messages } = createDeps();

    await consumeAgentStream(
      events([
        { type: 'turn-start', iteration: 1 },
        { type: 'text-delta', text: '直接答' },
        {
          type: 'result',
          result: {
            runId: 'r3',
            mode: 'auto',
            status: 'completed',
            summary: '直接答',
            report: {
              changedFiles: [],
              evidence: [],
              risks: []
            }
          }
        }
      ]),
      deps
    );

    expect(messages.map((m) => m.from)).toEqual(['agent']);
    expect(messages[0]?.text).toBe('直接答');
  });
});
