import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TraceEvent } from '../../domain';
import { ProcessManager } from '../../process/processManager';
import type { TraceStore } from '../../trace/traceStore';
import { ToolGateway } from '../toolGateway';
import { createProcessTools } from './processTools';

let root = '';
let manager: ProcessManager | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-process-tools-'));
});

afterEach(async () => {
  await manager?.close();
  await rm(root, { recursive: true, force: true });
});

describe('managed process tools', () => {
  it('registers all five tools and redacts env/stdin values from trace', async () => {
    const traceStore = new MemoryTraceStore();
    const gateway = new ToolGateway({
      traceStore,
      approvalPolicy: () => ({ action: 'allow' })
    });
    manager = new ProcessManager(root, { createProcessId: () => 'process-tools' });
    for (const tool of createProcessTools(manager)) gateway.register(tool);
    expect(gateway.listTools().map((tool) => tool.name)).toEqual([
      'ProcessStart',
      'ProcessPoll',
      'ProcessWrite',
      'ProcessKill',
      'ProcessList'
    ]);

    const secret = 'super-secret-env-value';
    const commandSecret = 'super-secret-command-value';
    const started = await gateway.call({
      runId: 'run-process',
      name: 'ProcessStart',
      input: {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.env.INLINE_SECRET='${commandSecret}'; process.stdin.on('data', () => {})`)}`,
        env: { PROCESS_SECRET: secret }
      }
    });
    await gateway.call({
      runId: 'run-process',
      name: 'ProcessWrite',
      input: { processId: 'process-tools', text: 'private-stdin-value', eof: true }
    });
    await gateway.call({
      runId: 'run-process',
      name: 'ProcessList',
      input: {}
    });

    const trace = JSON.stringify(traceStore.events);
    expect(trace).not.toContain(secret);
    expect(trace).not.toContain(commandSecret);
    expect(trace).not.toContain('private-stdin-value');
    expect(trace).toContain('PROCESS_SECRET');
    expect(trace).toContain('textBytes');
    expect(trace).toContain('commandPreview');
    expect(started.content).not.toContain(commandSecret);
  });
});

class MemoryTraceStore implements TraceStore {
  readonly events: TraceEvent[] = [];

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
