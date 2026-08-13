import React from 'react';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  HybridSessionStore,
  ProcessManager,
  type TraceEvent,
  type TraceStore
} from '@kross/core';
import { App, type AppTestApi } from './App';

describe('App managed process sessions', () => {
  it('binds lazy creation, picker and resume to explicit scopes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kross-process-scope-ui-'));
    const workspace = join(home, 'workspace');
    mkdirSync(workspace);
    let sessionSequence = 0;
    const sessionStore = new HybridSessionStore({
      krossHome: join(home, '.kross'),
      createSessionId: () => `scope-session-${sessionSequence++}`
    });
    const existing = sessionStore.createSession(workspace);
    const runtime = new AgentRuntime({ traceStore: new MemoryTraceStore() });
    const setScope = vi.spyOn(runtime, 'setManagedProcessSession');
    let api: AppTestApi | undefined;
    const view = render(
      <App
        runtime={runtime}
        cwd={workspace}
        sessionStore={sessionStore}
        onReady={(next) => (api = next)}
      />
    );

    try {
      await waitUntil(() => api !== undefined);
      await api!.submit('create the active session');
      expect(setScope).toHaveBeenCalledWith('scope-session-1');

      expect(await api!.resumeSession()).toBe(true);
      expect(setScope).toHaveBeenLastCalledWith(undefined);

      expect(await api!.resumeSession(existing.id)).toBe(true);
      expect(setScope).toHaveBeenLastCalledWith(existing.id);
    } finally {
      view.unmount();
      sessionStore.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('binds process access to the resumed persisted session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kross-process-session-ui-'));
    const workspace = join(home, 'workspace');
    mkdirSync(workspace);
    let sessionSequence = 0;
    const sessionStore = new HybridSessionStore({
      krossHome: join(home, '.kross'),
      createSessionId: () => `session-${sessionSequence++}`
    });
    const firstSession = sessionStore.createSession(workspace);
    const secondSession = sessionStore.createSession(workspace);
    const processManager = new ProcessManager(workspace, {
      createProcessId: () => 'session-owned-process'
    });
    const runtime = new AgentRuntime({
      traceStore: new MemoryTraceStore(),
      processManager
    });
    let api: AppTestApi | undefined;
    const view = render(
      <App
        runtime={runtime}
        cwd={workspace}
        sessionStore={sessionStore}
        onReady={(next) => (api = next)}
      />
    );

    try {
      await waitUntil(() => api !== undefined);
      expect(await api!.resumeSession(firstSession.id)).toBe(true);
      const started = await processManager.start({
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000)')}`
      });
      expect(runtime.listManagedProcesses()).toHaveLength(1);

      expect(await api!.resumeSession(secondSession.id)).toBe(true);
      expect(runtime.listManagedProcesses()).toEqual([]);
      expect(() => processManager.poll(started.processId)).toThrow(
        /Unknown managed process/
      );

      expect(await api!.resumeSession(firstSession.id)).toBe(true);
      expect(runtime.listManagedProcesses().map((item) => item.processId)).toEqual([
        started.processId
      ]);
    } finally {
      view.unmount();
      await processManager.close();
      sessionStore.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

class MemoryTraceStore implements TraceStore {
  async append(_event: TraceEvent): Promise<void> {}
  async readRun(_runId: string): Promise<TraceEvent[]> {
    return [];
  }
  async listRunIds(): Promise<string[]> {
    return [];
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}
