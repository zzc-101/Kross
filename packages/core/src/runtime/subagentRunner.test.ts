import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '../domain';
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk } from '../llm/types';
import type { TraceStore } from '../trace/traceStore';
import { ToolGateway } from '../tools/toolGateway';
import { createTaskTool } from '../tools/builtin/task';
import {
  createExploreTools,
  createSubagentTools
} from '../tools/builtin/exploreTools';
import { runSubagent } from './subagentRunner';

class InMemoryTraceStore implements TraceStore {
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

class ScriptedLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  constructor(private readonly text: string) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return {
      provider: this.provider,
      model: 'fake',
      text: this.text,
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    yield { type: 'text-delta', text: this.text };
    yield { type: 'done' };
  }
}

describe('runSubagent', () => {
  it('runs an isolated explore subagent and returns a structured result', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-subagent-'));
    try {
      writeFileSync(join(workspace, 'note.txt'), 'hello from workspace');
      const traceStore = new InMemoryTraceStore();
      const llm = new ScriptedLlmClient(
        'Found note.txt which says hello from workspace.'
      );

      const outcome = await runSubagent(
        {
          prompt: 'Summarize files in the workspace',
          mode: 'explore',
          parentRunId: 'parent-run-1',
          parentDepth: 0
        },
        {
          workspaceRoot: workspace,
          llmClient: llm,
          traceStore,
          maxToolIterations: 5
        }
      );

      expect(outcome.mode).toBe('explore');
      expect(outcome.result.status).toBe('completed');
      expect(outcome.result.summary).toContain('note.txt');
      expect(outcome.subRunId.startsWith('sub-parent-run-1')).toBe(true);

      const types = traceStore.events.map((event) => event.type);
      expect(types).toContain('subagent.started');
      expect(types).toContain('subagent.completed');
      // Dedicated path uses SUBAGENT system prompt, not planner shell.
      const system = llm.requests[0]?.messages.find((m) => m.role === 'system');
      expect(system?.content).toContain('focused subagent');
      expect(system?.content).not.toContain('规划器');
      // Child should not see parent history — only the task prompt as user turn.
      const userMessages = llm.requests.flatMap((request) =>
        request.messages.filter((message) => message.role === 'user')
      );
      expect(userMessages.some((message) => message.content.includes('Summarize'))).toBe(
        true
      );
      // Lifecycle + any tool traffic tagged isSubagent.
      expect(
        traceStore.events.some(
          (event) =>
            event.type === 'subagent.started' && event.payload.isSubagent === true
        )
      ).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects nested subagent depth', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-subagent-depth-'));
    try {
      const traceStore = new InMemoryTraceStore();
      await expect(
        runSubagent(
          {
            prompt: 'nested',
            parentRunId: 'p',
            parentDepth: 1
          },
          {
            workspaceRoot: workspace,
            traceStore,
            llmClient: new ScriptedLlmClient('nope')
          }
        )
      ).rejects.toThrow(/depth limit/i);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps general mode label without forcing explore', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-subagent-gen-'));
    try {
      const traceStore = new InMemoryTraceStore();
      const outcome = await runSubagent(
        {
          prompt: 'quick look',
          mode: 'general',
          parentRunId: 'p2',
          parentDepth: 0
        },
        {
          workspaceRoot: workspace,
          traceStore,
          llmClient: new ScriptedLlmClient('ok'),
          maxToolIterations: 3
        }
      );
      expect(outcome.mode).toBe('general');
      expect(outcome.modeForcedToExplore).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('auto-allows Edit/Write and does not register Bash/Delete/Task', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-subagent-tools-'));
    try {
      const tools = createSubagentTools(workspace).map((tool) => tool.name);
      expect(tools).toEqual(
        expect.arrayContaining(['Read', 'Edit', 'Write', 'Glob', 'Grep'])
      );
      expect(tools).not.toContain('Bash');
      expect(tools).not.toContain('Delete');
      expect(tools).not.toContain('Move');
      expect(tools).not.toContain('Task');

      const traceStore = new InMemoryTraceStore();
      // Smoke: subagent run with auto-approve path completes without approval-required.
      const outcome = await runSubagent(
        {
          prompt: 'reply ok',
          parentRunId: 'p-tools',
          parentDepth: 0
        },
        {
          workspaceRoot: workspace,
          traceStore,
          llmClient: new ScriptedLlmClient('ok'),
          maxToolIterations: 2
        }
      );
      expect(outcome.result.status).toBe('completed');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('Task tool', () => {
  it('registers as a gateway tool and returns subagent summary', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-task-tool-'));
    try {
      const traceStore = new InMemoryTraceStore();
      const gateway = new ToolGateway({ traceStore });
      for (const tool of createExploreTools(workspace)) {
        gateway.register(tool);
      }
      gateway.register(
        createTaskTool({
          parentDepth: 0,
          run: (request) =>
            runSubagent(request, {
              workspaceRoot: workspace,
              traceStore,
              llmClient: new ScriptedLlmClient('Task done: explored workspace.'),
              maxToolIterations: 3
            })
        })
      );

      const result = await gateway.call({
        runId: 'main-run',
        name: 'Task',
        input: { prompt: 'Explore the repo', description: 'scan' }
      });

      expect(result.status).toBe('completed');
      expect(result.summary).toContain('Task(scan)');
      expect(result.content).toContain('Task done');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('denies Task when parentDepth >= 1', async () => {
    const gateway = new ToolGateway();
    gateway.register(
      createTaskTool({
        parentDepth: 1,
        run: async () => {
          throw new Error('should not run');
        }
      })
    );

    const result = await gateway.call({
      runId: 'child',
      name: 'Task',
      input: { prompt: 'nope' }
    });
    expect(result.summary).toContain('nested Task denied');
  });
});
