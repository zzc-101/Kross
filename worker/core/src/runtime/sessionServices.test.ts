import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TodoStore } from '../todo/todoStore';
import { InMemoryTraceStore } from '../trace/inMemoryTraceStore';
import { AgentRuntime } from './agentRuntime';
import { FakeLlmClient } from './agentRuntime.testSupport';

let workspace = '';

afterEach(() => {
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function makeWorkspace(): string {
  workspace = mkdtempSync(join(tmpdir(), 'kross-runtime-workspace-'));
  return workspace;
}

describe('single-workspace session services', () => {
  it('injects instructions only from the platform workspace', async () => {
    const root = makeWorkspace();
    writeFileSync(join(root, 'AGENTS.md'), 'Use the workspace source material.');
    const llmClient = new FakeLlmClient('done');
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      workspaceRoot: root,
      llmClient
    });

    await runtime.run({ input: 'summarize' });

    const system = llmClient.requests[0]?.messages.find(
      (message) => message.role === 'system'
    );
    expect(system?.content).toContain('Use the workspace source material.');
    expect(system?.content).not.toContain('project registry');
    expect(system?.content).not.toContain('workspace roots');
  });

  it('describes the fixed structured-tool policy without local shell guidance', async () => {
    const root = makeWorkspace();
    const llmClient = new FakeLlmClient('done');
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      workspaceRoot: root,
      llmClient
    });

    await runtime.run({ input: 'create a document' });

    const system = llmClient.requests[0]?.messages.find(
      (message) => message.role === 'system'
    );
    expect(system?.content).toContain('固定的 Cloud 工具策略');
    expect(system?.content).toContain(`主工作目录：${root}`);
    expect(system?.content).not.toContain('Git 操作优先');
    expect(system?.content).not.toContain('使用 Bash');
  });

  it('restores the durable todo state', () => {
    const root = makeWorkspace();
    const firstTodos = new TodoStore();
    const first = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      workspaceRoot: root,
      todoStore: firstTodos
    });
    firstTodos.write({
      todos: [{ id: 't1', content: 'Continue work', status: 'in_progress' }]
    });

    const secondTodos = new TodoStore();
    const second = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      workspaceRoot: root,
      todoStore: secondTodos
    });
    expect(second.restoreWorkState(first.exportWorkState())).toBe(true);
    expect(secondTodos.list()).toEqual(firstTodos.list());
  });
});
