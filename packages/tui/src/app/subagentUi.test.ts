import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '@kross/core';

import {
  applySubagentTraceEvent,
  isSubagentRunId,
  isSubagentTraceEvent,
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
  it('detects subagent run ids and hard-tagged events', () => {
    expect(isSubagentRunId('sub-parent-abc')).toBe(true);
    expect(isSubagentRunId('run-main')).toBe(false);
    expect(
      isSubagentTraceEvent(
        event('tool_call.started', 'run-main', {
          isSubagent: true,
          toolName: 'Read'
        })
      )
    ).toBe(true);
    // Lifecycle on parent must still reach the panel reducer (not hard-filtered).
    expect(
      isSubagentTraceEvent(
        event('subagent.started', 'parent-1', {
          isSubagent: true,
          subRunId: 'sub-1'
        })
      )
    ).toBe(false);
  });

  it('tracks subagent lifecycle without main tool cards', () => {
    let state = applySubagentTraceEvent(
      [],
      event('subagent.started', 'parent-1', {
        subRunId: 'sub-parent-1-x',
        mode: 'explore',
        title: 'Scan auth',
        promptPreview: 'scan auth modules in detail please'
      })
    );
    expect(state).toHaveLength(1);
    expect(state[0]?.status).toBe('running');
    expect(state[0]?.title).toBe('Scan auth');
    expect(state[0]?.promptPreview).toBe('scan auth modules in detail please');

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

  it('marks subagent cancelled on Esc (subagent.cancelled)', () => {
    let state = applySubagentTraceEvent(
      [],
      event('subagent.started', 'parent-1', {
        isSubagent: true,
        subRunId: 'sub-1',
        mode: 'explore'
      })
    );
    state = applySubagentTraceEvent(
      state,
      event('tool_call.started', 'sub-1', {
        isSubagent: true,
        toolName: 'Read'
      })
    );
    expect(state[0]?.status).toBe('running');

    state = applySubagentTraceEvent(
      state,
      event('subagent.cancelled', 'parent-1', {
        isSubagent: true,
        subRunId: 'sub-1',
        reason: '用户按下 Esc'
      })
    );
    expect(state[0]?.status).toBe('cancelled');
    expect(state[0]?.currentTool).toBeUndefined();
    expect(state[0]?.summaryPreview).toMatch(/Esc|interrupted|中断/i);

    // 迟到的 tool 事件不能把 cancelled 打回 running
    state = applySubagentTraceEvent(
      state,
      event('tool_call.started', 'sub-1', {
        isSubagent: true,
        toolName: 'Grep'
      })
    );
    expect(state[0]?.status).toBe('cancelled');
  });

  it('falls back to cancelled when parent run is interrupted', () => {
    let state = applySubagentTraceEvent(
      [],
      event('subagent.started', 'run-main', {
        subRunId: 'sub-a',
        parentRunId: 'run-main',
        mode: 'explore'
      })
    );
    state = applySubagentTraceEvent(
      state,
      event('run.interrupted', 'run-main', { status: 'cancelled' })
    );
    expect(state[0]?.status).toBe('cancelled');
  });

  it('closes leftover running cards when parent run.completed', () => {
    let state = applySubagentTraceEvent(
      [],
      event('subagent.started', 'run-main', {
        subRunId: 'sub-zombie',
        parentRunId: 'run-main',
        mode: 'explore',
        title: '旧任务'
      })
    );
    // 模拟 UI 丢了 subagent.completed，主 run 却正常结束
    state = applySubagentTraceEvent(
      state,
      event('run.completed', 'run-main', { status: 'completed' })
    );
    expect(state[0]?.status).toBe('completed');
    expect(state[0]?.currentTool).toBeUndefined();
  });

  it('starting a new subagent supersedes sibling running cards on same parent', () => {
    let state = applySubagentTraceEvent(
      [],
      event('subagent.started', 'run-main', {
        subRunId: 'sub-old',
        parentRunId: 'run-main',
        mode: 'explore',
        title: '旧追加'
      })
    );
    state = applySubagentTraceEvent(
      state,
      event('subagent.started', 'run-main', {
        subRunId: 'sub-new',
        parentRunId: 'run-main',
        mode: 'explore',
        title: '新删除'
      })
    );
    expect(state).toHaveLength(2);
    expect(state[0]?.subRunId).toBe('sub-new');
    expect(state[0]?.status).toBe('running');
    expect(state.find((s) => s.subRunId === 'sub-old')?.status).toBe(
      'cancelled'
    );
  });

  it('prunes stale finished and zombie running subagents', () => {
    const now = 100_000;
    const pruned = pruneSubagentUi(
      [
        {
          subRunId: 'a',
          parentRunId: 'p',
          mode: 'explore',
          status: 'completed',
          toolCount: 2,
          updatedAt: now - 90_000
        },
        {
          subRunId: 'b',
          parentRunId: 'p',
          mode: 'explore',
          status: 'running',
          toolCount: 1,
          // 最近仍有活动 → 保留
          updatedAt: now - 30_000
        },
        {
          subRunId: 'zombie',
          parentRunId: 'p',
          mode: 'explore',
          status: 'running',
          toolCount: 1,
          // 超过 3min 无更新 → 僵尸丢掉
          updatedAt: now - 200_000
        },
        {
          subRunId: 'c',
          parentRunId: 'p',
          mode: 'explore',
          status: 'completed',
          toolCount: 1,
          updatedAt: now - 10_000
        },
        {
          subRunId: 'd',
          parentRunId: 'p',
          mode: 'explore',
          status: 'cancelled',
          toolCount: 1,
          updatedAt: now - 20_000
        },
        {
          subRunId: 'e',
          parentRunId: 'p',
          mode: 'explore',
          status: 'cancelled',
          toolCount: 0,
          updatedAt: now - 5_000
        }
      ],
      60_000,
      now,
      15_000,
      3 * 60_000
    );
    // a 过期 completed；zombie 过期 running；d 过期 cancelled
    expect(pruned.map((item) => item.subRunId).sort()).toEqual(['b', 'c', 'e']);
  });

  it('preserves state identity when no subagent needs pruning', () => {
    const current = [
      {
        subRunId: 'active',
        parentRunId: 'parent',
        mode: 'explore',
        status: 'running' as const,
        toolCount: 1,
        updatedAt: 100
      }
    ];

    expect(pruneSubagentUi(current, 60_000, 100_000)).toBe(current);
  });
});
