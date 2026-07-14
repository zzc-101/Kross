import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '@kross/core';

import {
  applySubagentTraceEvent,
  isSubagentRunId,
  pruneSubagentUi
} from './subagentUi';

function event(
  type: string,
  runId: string,
  payload: Record<string, unknown> = {}
): TraceEvent {
  return {
    id: `${type}-1`,
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload
  };
}

describe('subagentUi', () => {
  it('detects subagent run ids', () => {
    expect(isSubagentRunId('sub-parent-abc')).toBe(true);
    expect(isSubagentRunId('run-main')).toBe(false);
  });

  it('tracks subagent lifecycle without main tool cards', () => {
    let state = applySubagentTraceEvent(
      [],
      event('subagent.started', 'parent-1', {
        subRunId: 'sub-parent-1-x',
        mode: 'explore',
        promptPreview: 'scan auth'
      })
    );
    expect(state).toHaveLength(1);
    expect(state[0]?.status).toBe('running');
    expect(state[0]?.promptPreview).toBe('scan auth');

    state = applySubagentTraceEvent(
      state,
      event('tool_call.started', 'sub-parent-1-x', { toolName: 'Read' })
    );
    expect(state[0]?.currentTool).toBe('Read');
    expect(state[0]?.toolCount).toBe(1);

    state = applySubagentTraceEvent(
      state,
      event('subagent.completed', 'parent-1', {
        subRunId: 'sub-parent-1-x',
        summaryPreview: 'found login routes'
      })
    );
    expect(state[0]?.status).toBe('completed');
    expect(state[0]?.summaryPreview).toContain('login');
    expect(state[0]?.currentTool).toBeUndefined();
  });

  it('prunes stale finished subagents but keeps running ones', () => {
    const now = 100_000;
    const pruned = pruneSubagentUi(
      [
        {
          subRunId: 'a',
          parentRunId: 'p',
          mode: 'explore',
          status: 'completed',
          toolCount: 2,
          updatedAt: now - 20_000
        },
        {
          subRunId: 'b',
          parentRunId: 'p',
          mode: 'explore',
          status: 'running',
          toolCount: 1,
          updatedAt: now - 20_000
        }
      ],
      12_000,
      now
    );
    expect(pruned.map((item) => item.subRunId)).toEqual(['b']);
  });
});
