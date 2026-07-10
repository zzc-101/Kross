import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '../domain';
import type { TraceStore } from '../trace/traceStore';
import { RuntimeInspection } from './runtimeInspection';

describe('RuntimeInspection', () => {
  it('formats trace lists and rejects unsafe run ids', async () => {
    const traceStore = new MemoryTraceStore([
      event('run-1', 'run.started', { input: 'inspect workspace' }, 'e1'),
      event('run-1', 'mode.detected', { mode: 'normal' }, 'e2'),
      event(
        'run-1',
        'run.completed',
        { status: 'completed', mode: 'normal', summary: 'done' },
        'e3'
      )
    ]);
    const inspection = new RuntimeInspection({ traceStore });

    expect(await inspection.formatTraceCommand()).toContain('run-1');
    expect(await inspection.formatTraceCommand('../bad')).toContain(
      '无效 runId'
    );
  });

  it('formats diff output with injected git evidence', async () => {
    const traceStore = new MemoryTraceStore([
      event('run-2', 'run.started', { input: 'edit file' }, 'e1'),
      event(
        'run-2',
        'tool_call.completed',
        { toolName: 'Edit', input: { path: 'src/a.ts' } },
        'e2'
      )
    ]);
    const inspection = new RuntimeInspection({
      traceStore,
      workspaceRoot: '/workspace',
      runGit: async (args) => ({
        stdout: args[0] === 'status' ? ' M src/a.ts\n' : '',
        stderr: ''
      })
    });

    const output = await inspection.formatDiffCommand('run-2');

    expect(output).toContain('run: run-2');
    expect(output).toContain('src/a.ts');
    expect(output).toContain('M src/a.ts');
  });
});

class MemoryTraceStore implements TraceStore {
  constructor(readonly events: TraceEvent[]) {}

  async append(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }

  async listRunIds(): Promise<string[]> {
    return [...new Set(this.events.map((event) => event.runId))];
  }
}

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
    timestamp: '2026-07-10T00:00:00.000Z',
    payload
  };
}
