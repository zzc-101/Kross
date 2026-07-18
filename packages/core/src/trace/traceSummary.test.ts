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
      event('run-1', 'mode.detected', { mode: 'auto' }, 't2'),
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
          mode: 'auto',
          summary: '列出了几个目录'
        },
        't8'
      )
    ];

    const summary = summarizeTraceEvents('run-1', events);
    expect(summary).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      mode: 'auto',
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
        mode: 'auto',
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
        { status: 'completed', mode: 'auto', summary: 'finished' },
        't2'
      ),
      event('run-3', 'run.awaiting_approval', {}, 't3')
    ];
    const summary = summarizeTraceEvents('run-3', events);
    expect(summary?.status).toBe('completed');
    expect(summary?.flags).toContain('awaiting-tool-approval');
  });

  it('surfaces tool-loop stall detection, recovery, and final stop', () => {
    const events = [
      event('run-stall', 'run.started', { input: 'repeat' }, 't1'),
      event(
        'run-stall',
        'llm.tool_loop.stall_detected',
        { signaturePreview: 'Read', repeatedCount: 2 },
        't2'
      ),
      event(
        'run-stall',
        'llm.tool_loop.stall_recovery',
        { signaturePreview: 'Read', repeatedCount: 2 },
        't3'
      ),
      event(
        'run-stall',
        'llm.tool_loop.stalled',
        { signaturePreview: 'Read', repeatedCount: 3 },
        't4'
      )
    ];

    const summary = summarizeTraceEvents('run-stall', events);
    expect(summary?.flags).toEqual(
      expect.arrayContaining(['stall-detected', 'stall-recovery', 'stalled'])
    );
    expect(summary?.failureMessage).toContain('without progress');

    const detail = buildTraceDetail('run-stall', events);
    expect(detail?.highlights.map((item) => item.type)).toEqual(
      expect.arrayContaining([
        'llm.tool_loop.stall_detected',
        'llm.tool_loop.stall_recovery',
        'llm.tool_loop.stalled'
      ])
    );
    expect(formatTraceDetail(detail!)).toContain('stopped after recovery');
  });

  it('surfaces the structured verification status from run.completed', () => {
    const events = [
      event('run-verify', 'run.started', { input: 'test it' }, 't1'),
      event(
        'run-verify',
        'run.completed',
        {
          status: 'completed',
          mode: 'auto',
          summary: 'done',
          report: {
            verification: {
              status: 'failed',
              commands: ['npm test'],
              evidence: ['npm test: failed (exit=1)'],
              reason: 'At least one latest verification command failed.'
            }
          }
        },
        't2'
      )
    ];

    const summary = summarizeTraceEvents('run-verify', events);
    expect(summary?.flags).toContain('verification-failed');
    expect(summary?.failureMessage).toContain('verification command failed');
  });

  it('reconstructs phase and verification progress from trace events', () => {
    const events = [
      event('run-phases', 'run.started', { input: 'fix it' }, 't1'),
      event(
        'run-phases',
        'run.phase.changed',
        { previous: undefined, phase: 'inspect' },
        't2'
      ),
      event(
        'run-phases',
        'run.phase.changed',
        { previous: 'inspect', phase: 'act' },
        't3'
      ),
      event(
        'run-phases',
        'run.verification.started',
        { command: 'npm test' },
        't4'
      ),
      event(
        'run-phases',
        'run.phase.changed',
        { previous: 'act', phase: 'verify' },
        't5'
      ),
      event(
        'run-phases',
        'run.verification.completed',
        { status: 'passed', commandCount: 1 },
        't6'
      ),
      event(
        'run-phases',
        'run.phase.changed',
        { previous: 'verify', phase: 'complete' },
        't7'
      )
    ];

    const detail = buildTraceDetail('run-phases', events)!;
    expect(detail).toMatchObject({
      phase: 'complete',
      verificationStatus: 'passed',
      verificationCommandCount: 1
    });
    expect(detail.flags).toContain('verification-passed');
    expect(detail.flags).not.toContain('verification-running');
    expect(detail.highlights.map((item) => item.type)).toEqual(
      expect.arrayContaining([
        'run.phase.changed',
        'run.verification.started',
        'run.verification.completed'
      ])
    );
    expect(formatTraceDetail(detail)).toContain(
      'verification: passed · commands: 1'
    );
  });

  it('keeps only the latest verification conclusion in summary flags', () => {
    const events = [
      event(
        'run-retry',
        'run.verification.completed',
        { status: 'failed', commandCount: 1 },
        't1'
      ),
      event(
        'run-retry',
        'run.verification.completed',
        { status: 'passed', commandCount: 2 },
        't2'
      )
    ];

    const summary = summarizeTraceEvents('run-retry', events)!;
    expect(summary.flags).toContain('verification-passed');
    expect(summary.flags).not.toContain('verification-failed');
    expect(summary.verificationCommandCount).toBe(2);
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

  it('falls back to review.completed for legacy traces without run.completed', () => {
    const events = [
      event('run-legacy', 'run.started', { input: 'old task' }, 't1'),
      event(
        'run-legacy',
        'review.completed',
        { status: 'completed', summary: 'legacy summary' },
        't2'
      )
    ];
    const summary = summarizeTraceEvents('run-legacy', events);
    expect(summary?.status).toBe('completed');
    expect(summary?.summaryPreview).toBe('legacy summary');
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
