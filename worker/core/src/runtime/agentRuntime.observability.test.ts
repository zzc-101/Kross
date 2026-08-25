import { describe, expect, it } from 'vitest';

import { InMemoryTraceStore } from '../trace/inMemoryTraceStore';
import { AgentRuntime } from './agentRuntime';
import { FakeLlmClient } from './agentRuntime.testSupport';

describe('AgentRuntime SaaS observability', () => {
  it('reports context usage without exposing the context inspection panel', () => {
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('ok')
    });

    expect(runtime.getContextUsage()).toMatchObject({
      usedTokens: expect.any(Number),
      contextWindow: expect.any(Number),
      headerRatio: expect.any(Number)
    });
  });

  it('aggregates persisted LLM metrics for platform usage reporting', async () => {
    const traceStore = new InMemoryTraceStore();
    await traceStore.append({
      id: 'event-1',
      runId: 'run-usage',
      type: 'llm.planner.completed',
      timestamp: '2026-08-25T00:00:00.000Z',
      payload: {
        metrics: {
          status: 'completed',
          durationMs: 120,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            cacheReadTokens: 2,
            estimatedCostUsd: 0.001
          }
        }
      }
    });
    const runtime = new AgentRuntime({ traceStore });

    await expect(runtime.getRunUsage('run-usage')).resolves.toMatchObject({
      calls: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 2,
      estimatedCostUsd: 0.001,
      durationMs: 120
    });
  });
});
