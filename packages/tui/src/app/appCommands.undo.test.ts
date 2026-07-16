import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRuntime, MutationCoordinator, type TraceStore } from '@kross/core';
import { afterEach, describe, expect, it } from 'vitest';

import { handleCommand } from './appCommands';

const traceStore: TraceStore = {
  async append() {},
  async readRun() { return []; },
  async listRunIds() { return []; }
};

let temp = '';
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = '';
});

describe('/undo', () => {
  it('undoes a selected run and reports restored paths', async () => {
    temp = mkdtempSync(join(tmpdir(), 'kross-undo-command-'));
    const workspace = join(temp, 'workspace');
    mkdirSync(workspace);
    const file = join(workspace, 'a.txt');
    writeFileSync(file, 'before');
    const coordinator = new MutationCoordinator(join(temp, 'home'));
    await coordinator.forWorkspace(workspace).record({
      runId: 'run-1',
      toolName: 'Write',
      paths: ['a.txt'],
      action: async () => writeFileSync(file, 'after')
    });
    const runtime = new AgentRuntime({
      traceStore,
      workspaceRoot: workspace,
      mutationCoordinator: coordinator
    });
    const messages: string[] = [];

    const handled = handleCommand(
      '/undo run-1',
      (_from, text) => messages.push(text),
      () => {},
      () => {},
      runtime,
      'auto',
      undefined,
      undefined,
      () => {},
      () => {},
      () => {},
      false,
      async () => {},
      () => {}
    );

    expect(handled).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('before');
    expect(messages[0]).toContain('a.txt');
  });
});
