import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '../domain';
import { fingerprintCommand } from './verificationCommand';
import { identifyRequestedVerificationCommand } from './verificationCommand';
import {
  assessVerificationGate,
  collectVerificationReport
} from './verificationReport';

describe('collectVerificationReport', () => {
  it('returns not-needed for a read-only run without verification commands', () => {
    expect(
      collectVerificationReport([], { changedFiles: [] })
    ).toMatchObject({ status: 'not-needed', commands: [] });
  });

  it('returns not-run when files changed without recognized verification', () => {
    expect(
      collectVerificationReport([], { changedFiles: ['src/a.ts'] })
    ).toMatchObject({
      status: 'not-run',
      reason: expect.stringContaining('no recognized verification command')
    });
  });

  it('collects a successful Bash verification with exit, iteration and time', () => {
    const report = collectVerificationReport(
      [
        event('tool_call.started', {
          toolName: 'Bash',
          callId: 'bash-1',
          iteration: 3,
          input: {
            commandFingerprint: fingerprintCommand('npm test -- --run a.test.ts'),
            verificationCommand: 'npm test'
          }
        }),
        event(
          'tool_call.completed',
          {
            toolName: 'Bash',
            callId: 'bash-1',
            data: { exitCode: 0 },
            summary: 'exit=0, 20 lines'
          },
          1
        )
      ],
      { changedFiles: ['src/a.ts'] }
    );

    expect(report).toMatchObject({
      status: 'passed',
      commands: ['npm test']
    });
    expect(report.evidence[0]).toContain('exit=0');
    expect(report.evidence[0]).toContain('iteration=3');
    expect(report.evidence[0]).toContain('2026-07-18T00:00:01.000Z');
  });

  it('keeps failures for different checks but allows a rerun of the same check to pass', () => {
    const events = [
      ...bashOutcome('test-1', 'npm test', 1, 0),
      ...bashOutcome('types-1', 'npm run typecheck', 2, 2),
      ...bashOutcome('test-2', 'npm test', 0, 4)
    ];
    const failed = collectVerificationReport(events, {
      changedFiles: ['src/a.ts']
    });
    expect(failed.status).toBe('failed');

    const passed = collectVerificationReport(
      [...events, ...bashOutcome('types-2', 'npm run typecheck', 0, 6)],
      { changedFiles: ['src/a.ts'] }
    );
    expect(passed.status).toBe('passed');
  });

  it('tracks a background verification through ProcessStart and ProcessPoll', () => {
    const fingerprint = fingerprintCommand('npm run build');
    const report = collectVerificationReport(
      [
        event('tool_call.started', {
          toolName: 'ProcessStart',
          callId: 'start-1',
          iteration: 2,
          input: {
            commandFingerprint: fingerprint,
            verificationCommand: 'npm run build'
          }
        }),
        event('tool_call.completed', {
          toolName: 'ProcessStart',
          callId: 'start-1',
          data: { processId: 'process-1', status: 'running' }
        }, 1),
        event('tool_call.completed', {
          toolName: 'ProcessPoll',
          callId: 'poll-1',
          data: { processId: 'process-1', status: 'exited', exitCode: 0 }
        }, 2)
      ],
      { changedFiles: ['src/a.ts'] }
    );

    expect(report).toMatchObject({
      status: 'passed',
      commands: ['npm run build']
    });
  });

  it('reports an observed background check without terminal poll as not-run', () => {
    const report = collectVerificationReport(
      [
        event('tool_call.started', {
          toolName: 'ProcessStart',
          callId: 'start-1',
          input: {
            commandFingerprint: fingerprintCommand('npm test'),
            verificationCommand: 'npm test'
          }
        }),
        event('tool_call.completed', {
          toolName: 'ProcessStart',
          callId: 'start-1',
          data: { processId: 'process-1', status: 'running' }
        }, 1)
      ],
      { changedFiles: ['src/a.ts'] }
    );

    expect(report.status).toBe('not-run');
    expect(report.evidence[0]).toContain('completion not observed');
  });

  it('recognizes an opaque configured project test command by fingerprint', () => {
    const command = './scripts/project-check.sh --all';
    const report = collectVerificationReport(
      [
        event('tool_call.started', {
          toolName: 'Bash',
          callId: 'custom-1',
          input: { commandFingerprint: fingerprintCommand(command) }
        }),
        event('tool_call.completed', {
          toolName: 'Bash',
          callId: 'custom-1',
          data: { exitCode: 0 }
        }, 1)
      ],
      {
        changedFiles: ['src/a.ts'],
        knownCommands: [{ command, label: 'project test (app/api)' }]
      }
    );

    expect(report).toMatchObject({
      status: 'passed',
      commands: ['project test (app/api)']
    });
    expect(JSON.stringify(report)).not.toContain('project-check.sh');
  });

  it('invalidates verification that ran before the last file mutation', () => {
    const report = collectVerificationReport(
      [
        ...bashOutcome('test-before', 'npm test', 0, 0),
        fileMutation('Edit', 'src/a.ts', 2)
      ],
      { changedFiles: ['src/a.ts'] }
    );

    expect(report).toMatchObject({
      status: 'not-run',
      commands: [],
      reason: expect.stringContaining('invalidated')
    });
  });

  it('does not accept a check that started before and completed after mutation', () => {
    const events = [
      event('tool_call.started', {
        toolName: 'Bash',
        callId: 'parallel-test',
        input: {
          commandFingerprint: fingerprintCommand('npm test'),
          verificationCommand: 'npm test'
        }
      }, 0),
      fileMutation('Write', 'src/a.ts', 1),
      event('tool_call.completed', {
        toolName: 'Bash',
        callId: 'parallel-test',
        data: { exitCode: 0 }
      }, 2)
    ];

    expect(
      collectVerificationReport(events, { changedFiles: ['src/a.ts'] })
    ).toMatchObject({ status: 'not-run', commands: [] });
  });

  it('accepts a passing rerun after a fix and requires checks only for non-doc changes', () => {
    const events = [
      ...bashOutcome('test-failed', 'npm test', 1, 0),
      fileMutation('Edit', 'src/a.ts', 2),
      ...bashOutcome('test-after-fix', 'npm test', 0, 3)
    ];
    const codeGate = assessVerificationGate(events, {
      changedFiles: ['src/a.ts']
    });

    expect(codeGate).toMatchObject({
      required: true,
      satisfied: true,
      report: { status: 'passed' }
    });
    expect(
      assessVerificationGate([], { changedFiles: ['docs/guide.md'] })
    ).toMatchObject({
      required: false,
      satisfied: true,
      report: { status: 'not-run' }
    });
  });

  it('requires an explicitly requested command even for a read-only run', () => {
    const requestedCommand = identifyRequestedVerificationCommand(
      '请运行 `npm test`'
    );
    expect(
      assessVerificationGate([], { changedFiles: [], requestedCommand })
    ).toMatchObject({
      required: true,
      satisfied: false,
      report: { status: 'not-run' },
      reason: expect.stringContaining('npm test')
    });
  });

  it('requires test plus build for CLI or package-level changes', () => {
    const testOnlyEvents = bashOutcome('test-1', 'npm test', 0, 0);
    expect(
      assessVerificationGate(testOnlyEvents, {
        changedFiles: ['packages/core/src/cli/index.ts']
      })
    ).toMatchObject({
      required: true,
      satisfied: false,
      requiredKinds: ['test', 'build'],
      observedKinds: ['test']
    });

    expect(
      assessVerificationGate(
        [
          ...testOnlyEvents,
          ...bashOutcome('build-1', 'npm run build', 0, 2)
        ],
        { changedFiles: ['packages/core/src/cli/index.ts'] }
      )
    ).toMatchObject({
      satisfied: true,
      observedKinds: expect.arrayContaining(['test', 'build'])
    });
  });
});

function bashOutcome(
  callId: string,
  label: string,
  exitCode: number,
  index: number
): TraceEvent[] {
  return [
    event('tool_call.started', {
      toolName: 'Bash',
      callId,
      input: {
        commandFingerprint: fingerprintCommand(label),
        verificationCommand: label
      }
    }, index),
    event('tool_call.completed', {
      toolName: 'Bash',
      callId,
      data: { exitCode }
    }, index + 1)
  ];
}

function event(
  type: string,
  payload: Record<string, unknown>,
  index = 0
): TraceEvent {
  return {
    id: `event-${type}-${index}`,
    runId: 'run-verification',
    type,
    timestamp: `2026-07-18T00:00:${String(index).padStart(2, '0')}.000Z`,
    payload
  };
}

function fileMutation(
  toolName: 'Write' | 'Edit',
  path: string,
  index: number
): TraceEvent {
  return event(
    'tool_call.completed',
    {
      toolName,
      input: { path },
      summary:
        toolName === 'Edit' ? 'replaced 1 occurrence(s)' : 'wrote 10 bytes'
    },
    index
  );
}
