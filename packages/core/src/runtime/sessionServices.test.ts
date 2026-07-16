import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SessionContext } from '../context/sessionContext';
import type { TraceStore } from '../trace/traceStore';
import { AgentRuntime } from './agentRuntime';

const traceStore: TraceStore = {
  async append() {},
  async readRun() {
    return [];
  },
  async listRunIds() {
    return [];
  }
};

let workspace = '';

afterEach(() => {
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function makeWorkspace(): string {
  workspace = mkdtempSync(join(tmpdir(), 'kross-runtime-instructions-'));
  return workspace;
}

describe('project instructions in AgentRuntime', () => {
  it('loads project instructions during construction as pinned context sources', () => {
    const root = makeWorkspace();
    writeFileSync(join(root, 'AGENTS.md'), 'Always run focused tests.');

    const runtime = new AgentRuntime({ traceStore, workspaceRoot: root });
    const instructions = runtime.getProjectInstructions();
    const context = runtime.inspectContext({ requestedMode: 'auto' });

    expect(instructions.files).toHaveLength(1);
    expect(context.includedSources).toContain(
      `project-instruction:${instructions.files[0]?.rootId}:AGENTS.md`
    );
    expect(context.pinnedSources).toContain(
      `project-instruction:${instructions.files[0]?.rootId}:AGENTS.md`
    );
    expect(context.messages[0]?.content).toContain('Always run focused tests.');
  });

  it('refreshes changed files and removes stale sources before inspection', () => {
    const root = makeWorkspace();
    const path = join(root, 'AGENTS.md');
    writeFileSync(path, 'old rules');
    const runtime = new AgentRuntime({ traceStore, workspaceRoot: root });
    const oldSignature = runtime.getProjectInstructions().signature;

    writeFileSync(path, 'new rules');
    const refreshed = runtime.inspectContext({ requestedMode: 'auto' });

    expect(runtime.getProjectInstructions().signature).not.toBe(oldSignature);
    expect(refreshed.messages[0]?.content).toContain('new rules');
    expect(refreshed.messages[0]?.content).not.toContain('old rules');

    unlinkSync(path);
    const removed = runtime.refreshProjectInstructions();
    const withoutSource = runtime.inspectContext({ requestedMode: 'auto' });
    expect(removed.files).toEqual([]);
    expect(withoutSource.includedSources).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^project-instruction:/)])
    );
  });

  it('does not persist instruction bodies and reloads current disk rules after restore', () => {
    const root = makeWorkspace();
    const path = join(root, 'KROSS.md');
    writeFileSync(path, 'rules from checkpoint time');
    const first = new AgentRuntime({ traceStore, workspaceRoot: root });
    const state = first.exportContextState();

    expect(JSON.stringify(state)).not.toContain('rules from checkpoint time');

    writeFileSync(path, 'rules from current disk');
    const restored = new AgentRuntime({ traceStore, workspaceRoot: root });
    expect(restored.restoreContextState(state)).toBe(true);

    const context = restored.inspectContext({ requestedMode: 'auto' });
    expect(context.messages[0]?.content).toContain('rules from current disk');
    expect(context.messages[0]?.content).not.toContain('rules from checkpoint time');
  });

  it('keeps the existing context behavior when no instructions exist', () => {
    const root = makeWorkspace();
    const runtime = new AgentRuntime({ traceStore, workspaceRoot: root });

    expect(runtime.getProjectInstructions().files).toEqual([]);
    expect(runtime.inspectContext({ requestedMode: 'auto' }).includedSources).toEqual([
      'session-mode'
    ]);
  });
});
