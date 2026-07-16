import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  it('injects instructions only from the selected child root and traces provenance', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'kross-subagent-instructions-'));
    try {
      const main = join(parent, 'main');
      const api = join(parent, 'api');
      mkdirSync(main);
      mkdirSync(api);
      writeFileSync(join(main, 'AGENTS.md'), 'MAIN ROOT SECRET RULE');
      writeFileSync(join(api, 'KROSS.md'), 'API ROOT SCOPED RULE');
      const mainSkill = join(main, '.agents', 'skills', 'main-only');
      const apiSkill = join(api, '.agents', 'skills', 'api-only');
      mkdirSync(mainSkill, { recursive: true });
      mkdirSync(apiSkill, { recursive: true });
      writeFileSync(
        join(mainSkill, 'SKILL.md'),
        '---\ndescription: MAIN SKILL SECRET\n---\nmain body'
      );
      writeFileSync(
        join(apiSkill, 'SKILL.md'),
        '---\ndescription: API scoped skill\n---\nAPI SKILL BODY'
      );
      const traceStore = new InMemoryTraceStore();
      const llm = new ScriptedLlmClient('done');

      await runSubagent(
        {
          prompt: 'Work only in API',
          parentRunId: 'parent-scoped',
          parentDepth: 0,
          repoId: 'api',
          workspaceRoot: api
        },
        {
          workspaceRoot: main,
          allowedWorkspaceRoots: [main, api],
          traceStore,
          llmClient: llm
        }
      );

      const system = llm.requests[0]?.messages.find((message) => message.role === 'system');
      expect(system?.content).toContain('API ROOT SCOPED RULE');
      expect(system?.content).not.toContain('MAIN ROOT SECRET RULE');
      expect(system?.content).toContain('API scoped skill');
      expect(system?.content).not.toContain('API SKILL BODY');
      expect(system?.content).not.toContain('MAIN SKILL SECRET');
      expect(llm.requests[0]?.tools?.map((tool) => tool.name)).toContain('ReadSkill');

      const started = traceStore.events.find((event) => event.type === 'subagent.started');
      expect(started?.payload).toMatchObject({
        projectInstructions: [
          expect.objectContaining({
            filename: 'KROSS.md',
            rootId: 'api',
            truncated: false,
            injectedBytes: expect.any(Number)
          })
        ],
        projectInstructionDiagnosticCount: 0
      });
      expect(JSON.stringify(traceStore.events)).not.toContain('API ROOT SCOPED RULE');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

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
        expect.arrayContaining(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Rg'])
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

describe('runSubagent stall guard', () => {
  it('stops when the model repeats the same tool calls without progress', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-subagent-stall-'));
    try {
      writeFileSync(join(workspace, 'a.txt'), 'hello');
      const traceStore = new InMemoryTraceStore();

      class RepeatToolLlm implements LlmClient {
        readonly provider = 'openai' as const;
        calls = 0;

        async complete(): Promise<LlmResponse> {
          this.calls += 1;
          return {
            provider: this.provider,
            model: 'fake',
            text: '',
            raw: {},
            toolCalls: [
              {
                id: `call-${this.calls}`,
                name: 'Read',
                input: { path: 'a.txt' }
              }
            ]
          };
        }

        async *stream(): AsyncIterable<LlmStreamChunk> {
          yield { type: 'done' };
        }
      }

      const llm = new RepeatToolLlm();
      const outcome = await runSubagent(
        {
          prompt: 'read a.txt forever',
          parentRunId: 'parent-stall',
          parentDepth: 0
        },
        {
          workspaceRoot: workspace,
          llmClient: llm,
          traceStore,
          maxToolIterations: 20
        }
      );

      // 第 1 轮执行工具，第 2 轮相同签名计数 1，第 3 轮计数 2 → 收束
      expect(llm.calls).toBeLessThanOrEqual(4);
      expect(outcome.result.summary).toMatch(/repeated|stopped|progress/i);
      expect(traceStore.events.map((e) => e.type)).toContain(
        'llm.subagent.stalled'
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('runSubagent abort', () => {
  it('forwards AbortSignal to the LLM complete call and cancels mid-request', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-subagent-abort-llm-'));
    try {
      const traceStore = new InMemoryTraceStore();
      const controller = new AbortController();
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });

      class HangingLlmClient implements LlmClient {
        readonly provider = 'openai' as const;
        signal?: AbortSignal;

        async complete(request: LlmRequest): Promise<LlmResponse> {
          this.signal = request.signal;
          markStarted?.();
          return new Promise((_, reject) => {
            if (!request.signal) {
              reject(new Error('missing signal'));
              return;
            }
            if (request.signal.aborted) {
              reject(request.signal.reason);
              return;
            }
            request.signal.addEventListener(
              'abort',
              () => reject(request.signal?.reason),
              { once: true }
            );
          });
        }

        async *stream(): AsyncIterable<LlmStreamChunk> {
          yield { type: 'done' };
        }
      }

      const llm = new HangingLlmClient();
      const run = runSubagent(
        {
          prompt: 'hang please',
          parentRunId: 'parent-abort',
          parentDepth: 0,
          signal: controller.signal
        },
        {
          workspaceRoot: workspace,
          llmClient: llm,
          traceStore,
          maxToolIterations: 3
        }
      );

      await started;
      controller.abort(new Error('用户按下 Esc'));
      await expect(run).rejects.toThrow('用户按下 Esc');
      expect(llm.signal?.aborted).toBe(true);
      expect(traceStore.events.map((event) => event.type)).toContain(
        'subagent.cancelled'
      );
      expect(traceStore.events.map((event) => event.type)).not.toContain(
        'subagent.failed'
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('stops before child tools when signal aborts after the LLM tool_calls turn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-subagent-abort-tool-'));
    try {
      const traceStore = new InMemoryTraceStore();
      const controller = new AbortController();

      class ToolCallingLlm implements LlmClient {
        readonly provider = 'openai' as const;

        async complete(_request: LlmRequest): Promise<LlmResponse> {
          return {
            provider: this.provider,
            model: 'fake',
            text: '',
            raw: {},
            toolCalls: [
              {
                id: 'call-read-1',
                name: 'Read',
                input: { path: 'missing.txt' }
              }
            ]
          };
        }

        async *stream(): AsyncIterable<LlmStreamChunk> {
          yield { type: 'done' };
        }
      }

      const llm = new ToolCallingLlm();
      const original = llm.complete.bind(llm);
      llm.complete = async (request: LlmRequest) => {
        const response = await original(request);
        // Abort after tool_calls are produced so executeToolCalls sees aborted signal
        // (throwIfAborted / gateway.call(signal)) before any child tool runs.
        controller.abort(new Error('stop child tools'));
        await Promise.resolve();
        return response;
      };

      await expect(
        runSubagent(
          {
            prompt: 'read something',
            parentRunId: 'parent-tool-abort',
            parentDepth: 0,
            signal: controller.signal
          },
          {
            workspaceRoot: workspace,
            llmClient: llm,
            traceStore,
            maxToolIterations: 3
          }
        )
      ).rejects.toThrow('stop child tools');

      const types = traceStore.events.map((event) => event.type);
      expect(types).toContain('subagent.cancelled');
      expect(types).not.toContain('tool_call.started');
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
      input: { description: 'denied', prompt: 'nope' }
    });
    expect(result.summary).toContain('nested Task denied');
  });

  it('requires description (short title) from the model', async () => {
    const gateway = new ToolGateway();
    gateway.register(
      createTaskTool({
        parentDepth: 0,
        run: async () => {
          throw new Error('should not run');
        }
      })
    );

    await expect(
      gateway.call({
        runId: 'main',
        name: 'Task',
        input: { prompt: 'full instructions without title' }
      })
    ).rejects.toThrow(/Invalid input|description|required/i);
  });

  it('forwards description as subagent title', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-task-title-'));
    try {
      const traceStore = new InMemoryTraceStore();
      let seenTitle: string | undefined;
      const gateway = new ToolGateway({ traceStore });
      gateway.register(
        createTaskTool({
          parentDepth: 0,
          run: async (request) => {
            seenTitle = request.title;
            return runSubagent(request, {
              workspaceRoot: workspace,
              traceStore,
              llmClient: new ScriptedLlmClient('ok'),
              maxToolIterations: 2
            });
          }
        })
      );

      await gateway.call({
        runId: 'main-title',
        name: 'Task',
        input: {
          description: '追加 test.txt',
          prompt: '请在 test.txt 末尾追加三行内容'
        }
      });

      expect(seenTitle).toBe('追加 test.txt');
      const started = traceStore.events.find((e) => e.type === 'subagent.started');
      expect(started?.payload.title).toBe('追加 test.txt');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rethrows abort errors instead of wrapping them as Task failed content', async () => {
    const controller = new AbortController();
    const gateway = new ToolGateway();
    gateway.register(
      createTaskTool({
        parentDepth: 0,
        run: async ({ signal }) => {
          controller.abort(new Error('用户按下 Esc'));
          // Simulate subagent surface that already threw an abort-shaped error
          // while the external signal is aborted.
          throw signal?.reason ?? new Error('aborted');
        }
      })
    );

    await expect(
      gateway.call({
        runId: 'main-abort-task',
        name: 'Task',
        input: { description: 'abort test', prompt: 'do work' },
        signal: controller.signal,
        returnErrors: true
      })
    ).rejects.toThrow('用户按下 Esc');
  });
});
