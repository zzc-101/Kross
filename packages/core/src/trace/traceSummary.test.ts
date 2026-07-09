import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '../domain';
import {
  buildTraceDetail,
  formatTraceDetail,
  formatTraceList,
  summarizeTraceEvents
} from './traceSummary';

describe('traceSummary', () => {
  it('returns null for empty event lists', () => {
    expect(summarizeTraceEvents('run-1', [])).toBeNull();
    expect(buildTraceDetail('run-1', [])).toBeNull();
  });

  it('summarizes status, tools, flags and failures', () => {
    const events = [
      event('run-1', 'run.started', { input: '看看当前目录有哪些文件夹' }, 't1'),
      event('run-1', 'mode.detected', { mode: 'normal' }, 't2'),
      event('run-1', 'context.built', { estimatedChars: 1200, includedSources: [1, 2] }, 't3'),
      event(
        'run-1',
        'tool_call.approval_required',
        { toolName: 'Bash', risk: 'execute', callId: 'c1' },
        't4'
      ),
      event(
        'run-1',
        'tool_call.started',
        { toolName: 'Bash', callId: 'c1' },
        't5'
      ),
      event(
        'run-1',
        'tool_call.completed',
        { toolName: 'Bash', callId: 'c1', summary: 'ok', durationMs: 12 },
        't6'
      ),
      event(
        'run-1',
        'tool_call.failed',
        { toolName: 'Write', message: 'permission denied' },
        't7'
      ),
      event(
        'run-1',
        'run.completed',
        {
          status: 'completed',
          mode: 'normal',
          summary: '列出了几个目录'
        },
        't8'
      )
    ];

    const summary = summarizeTraceEvents('run-1', events);
    expect(summary).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      mode: 'normal',
      inputPreview: '看看当前目录有哪些文件夹',
      summaryPreview: '列出了几个目录',
      tools: expect.arrayContaining(['Bash', 'Write']),
      toolStats: {
        total: 2,
        completed: 1,
        failed: 1,
        approvalRequired: 1,
        denied: 0,
        rejected: 0
      },
      failureMessage: 'permission denied'
    });
    expect(summary?.flags).toEqual(
      expect.arrayContaining(['context-built', 'tool-approval', 'tool-failed'])
    );

    const detail = buildTraceDetail('run-1', events);
    expect(detail?.toolLines).toHaveLength(4);
    expect(detail?.highlights.some((item) => item.type === 'tool_call.failed')).toBe(
      true
    );

    const text = formatTraceDetail(detail!);
    expect(text).toContain('Trace: run-1');
    expect(text).toContain('Bash completed');
    expect(text).toContain('Write failed');
    expect(text).toContain('permission denied');
  });

  it('formats empty and non-empty lists', () => {
    expect(formatTraceList([])).toContain('最近运行：无');

    const list = formatTraceList([
      {
        runId: 'run-a',
        eventCount: 3,
        status: 'completed',
        mode: 'normal',
        inputPreview: 'hello',
        tools: ['Read'],
        toolStats: {
          total: 1,
          completed: 1,
          failed: 0,
          approvalRequired: 0,
          denied: 0,
          rejected: 0
        },
        flags: []
      }
    ]);
    expect(list).toContain('run-a');
    expect(list).toContain('hello');
    expect(list).toContain('/trace <runId>');
  });

  it('marks awaiting approval status when run is paused', () => {
    const events = [
      event('run-2', 'run.started', { input: 'rm -rf /' }, 't1'),
      event('run-2', 'run.awaiting_approval', {}, 't2')
    ];
    const summary = summarizeTraceEvents('run-2', events);
    expect(summary?.status).toBe('approval-required');
    expect(summary?.flags).toContain('awaiting-tool-approval');
  });

  it('does not let awaiting_approval overwrite a terminal status', () => {
    const events = [
      event('run-3', 'run.started', { input: 'done task' }, 't1'),
      event(
        'run-3',
        'run.completed',
        { status: 'completed', mode: 'normal', summary: 'finished' },
        't2'
      ),
      event('run-3', 'run.awaiting_approval', {}, 't3')
    ];
    const summary = summarizeTraceEvents('run-3', events);
    expect(summary?.status).toBe('completed');
    expect(summary?.flags).toContain('awaiting-tool-approval');
  });

  it('counts pre-start approval as tool activity in total', () => {
    const events = [
      event('run-4', 'run.started', { input: 'bash' }, 't1'),
      event(
        'run-4',
        'tool_call.approval_required',
        { toolName: 'Bash', risk: 'execute' },
        't2'
      ),
      event('run-4', 'run.awaiting_approval', {}, 't3')
    ];
    const summary = summarizeTraceEvents('run-4', events);
    expect(summary?.toolStats.total).toBe(1);
    expect(summary?.toolStats.approvalRequired).toBe(1);
    expect(summary?.tools).toContain('Bash');
  });
});

function event(
  runId: string,
  type: string,
  payload: Record<string, unknown>,
  id: string
): TraceEvent {
  return {
    id,
    runId,
    type,
    timestamp: `2026-07-09T10:00:0${id.slice(1)}.000Z`,
    payload
  };
}
