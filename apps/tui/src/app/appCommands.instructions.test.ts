import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentRuntime,
  WorkspaceRoots,
  loadProjectInstructions,
  type TraceStore
} from '@kross/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatProjectInstructionsInspection,
  handleCommand
} from './appCommands';

const traceStore: TraceStore = {
  async append() {},
  async readRun() {
    return [];
  },
  async listRunIds() {
    return [];
  }
};

let tempRoot = '';

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

function runCommand(value: string, runtime: AgentRuntime) {
  const messages: Array<{ from: string; text: string }> = [];
  const handled = handleCommand(
    value,
    (from, text) => messages.push({ from, text }),
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
  return { handled, messages };
}

describe('/instructions', () => {
  it('formats provenance, budgets and diagnostics without instruction bodies', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kross-instructions-command-'));
    writeFileSync(join(tempRoot, 'AGENTS.md'), 'DO NOT PRINT THIS BODY');
    mkdirSync(join(tempRoot, 'KROSS.md'));
    const snapshot = loadProjectInstructions({
      roots: [{ id: 'main', path: tempRoot, primary: true }]
    });

    const text = formatProjectInstructionsInspection(snapshot);

    expect(text).toContain('Project instructions');
    expect(text).toContain('loaded: 1 files');
    expect(text).toContain('root=main');
    expect(text).toContain('source=AGENTS.md');
    expect(text).toContain('precedence=20');
    expect(text).toContain('not-file');
    expect(text).not.toContain('DO NOT PRINT THIS BODY');
  });

  it('refreshes before displaying the current state', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kross-instructions-command-'));
    const runtime = new AgentRuntime({ traceStore, workspaceRoot: tempRoot });
    const refresh = vi.spyOn(runtime, 'refreshProjectInstructions');
    writeFileSync(join(tempRoot, 'AGENTS.md'), 'new disk rules');

    const result = runCommand('/instructions', runtime);

    expect(result.handled).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(result.messages[0]?.text).toContain('source=AGENTS.md');
    expect(result.messages[0]?.text).not.toContain('new disk rules');
  });

  it('refreshes project instructions after add-dir and remove-dir', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kross-instructions-command-'));
    const main = join(tempRoot, 'main');
    const extra = join(tempRoot, 'api');
    mkdirSync(main);
    mkdirSync(extra);
    writeFileSync(join(extra, 'KROSS.md'), 'api only');
    const roots = new WorkspaceRoots(main);
    const runtime = new AgentRuntime({
      traceStore,
      workspaceRoot: main,
      workspaceRoots: roots
    });

    runCommand(`/add-dir ${extra}`, runtime);
    expect(runtime.getProjectInstructions().files.map((file) => file.rootId)).toContain(
      'api'
    );

    runCommand('/remove-dir api', runtime);
    expect(runtime.getProjectInstructions().files.map((file) => file.rootId)).not.toContain(
      'api'
    );
  });
});
