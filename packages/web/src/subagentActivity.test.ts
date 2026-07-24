import { describe, expect, it } from 'vitest';

import {
  deriveSubagentActivities,
  isSubagentToolTrace
} from './subagentActivity';

const trace = (
  type: string,
  runId: string,
  payload: Record<string, unknown>,
  second: number
) => ({
  id: `${type}-${second}`,
  runId,
  type,
  timestamp: `2026-07-24T00:00:${String(second).padStart(2, '0')}.000Z`,
  payload
});

describe('subagent activity', () => {
  it('汇总生命周期与子代理工具调用', () => {
    const activities = deriveSubagentActivities([
      trace('subagent.started', 'parent-1', {
        subRunId: 'sub-parent-1-a',
        title: '检查测试',
        mode: 'explore'
      }, 1),
      trace('tool_call.started', 'sub-parent-1-a', {
        toolName: 'Read',
        isSubagent: true
      }, 2),
      trace('tool_call.completed', 'sub-parent-1-a', {
        toolName: 'Read',
        isSubagent: true
      }, 3),
      trace('subagent.completed', 'parent-1', {
        subRunId: 'sub-parent-1-a',
        summaryPreview: '检查完成'
      }, 4)
    ]);

    expect(activities).toEqual([
      expect.objectContaining({
        title: '检查测试',
        status: 'completed',
        toolCount: 1,
        summary: '检查完成'
      })
    ]);
  });

  it('识别子代理工具事件但保留生命周期事件', () => {
    expect(isSubagentToolTrace(trace(
      'tool_call.started',
      'sub-parent-a',
      {},
      1
    ))).toBe(true);
    expect(isSubagentToolTrace(trace(
      'subagent.started',
      'parent',
      { isSubagent: true },
      1
    ))).toBe(false);
  });
});
