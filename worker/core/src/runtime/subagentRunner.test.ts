import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '../domain';
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk
} from '../llm/types';
import { renderPrompt } from '../prompts';
import type { TraceStore } from '../trace/traceStore';
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

  constructor(
    private readonly text: string,
    readonly model = 'fake'
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return {
      provider: this.provider,
      model: this.model,
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
  it('returns a work-oriented result from an isolated explore task', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'app-subagent-'));
    try {
      const traceStore = new InMemoryTraceStore();
      const llm = new ScriptedLlmClient('整理出三个行动项');

      const outcome = await runSubagent(
        {
          goal: '整理会议记录',
          mode: 'explore',
          parentRunId: 'parent-run-1'
        },
        {
          workspaceRoot: workspace,
          llmClient: llm,
          traceStore,
          activeSkill: {
            id: 'meeting-notes',
            name: 'Meeting Notes',
            description: 'Create structured meeting notes',
            content: 'Always include decisions and owners.',
            revision: 3
          },
          maxToolIterations: 5
        }
      );

      expect(outcome.result).toMatchObject({
        status: 'completed',
        summary: '整理出三个行动项',
        artifacts: [],
        incompleteItems: []
      });
      const system = llm.requests[0]?.messages.find(
        (message) => message.role === 'system'
      );
      expect(system?.content).toContain(renderPrompt('subagent.execution'));
      expect(system?.content).toContain(
        renderPrompt('subagent.execution.mode.explore')
      );
      expect(system?.content).toContain('meeting-notes, revision 3');
      expect(system?.content).toContain('Always include decisions and owners.');
      expect(llm.requests[0]?.tools?.map((tool) => tool.name)).not.toContain(
        'Write'
      );
      expect(traceStore.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(['subagent.started', 'subagent.completed'])
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('allows artifact tools only in general mode', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'app-subagent-general-'));
    try {
      const llm = new ScriptedLlmClient('产物已生成');
      await runSubagent(
        {
          goal: '生成摘要文档',
          mode: 'general',
          parentRunId: 'parent-run-2'
        },
        {
          workspaceRoot: workspace,
          llmClient: llm,
          traceStore: new InMemoryTraceStore()
        }
      );

      const toolNames = llm.requests[0]?.tools?.map((tool) => tool.name);
      expect(toolNames).toContain('Write');
      expect(toolNames).toContain('Edit');
      expect(toolNames).not.toContain('Bash');
      expect(toolNames).not.toContain('Task');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('uses the explicitly selected model profile', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'app-subagent-model-'));
    try {
      const inherited = new ScriptedLlmClient('inherited', 'main-model');
      const selected = new ScriptedLlmClient('selected', 'economy-model');
      const outcome = await runSubagent(
        {
          goal: '处理批量资料',
          parentRunId: 'parent-model',
          modelProfileId: 'economy'
        },
        {
          workspaceRoot: workspace,
          traceStore: new InMemoryTraceStore(),
          llmClient: inherited,
          resolveModelProfile: () => ({
            client: selected,
            profile: {
              id: 'economy',
              name: 'Economy',
              provider: 'openai',
              model: 'economy-model'
            }
          })
        }
      );

      expect(inherited.requests).toHaveLength(0);
      expect(selected.requests.length).toBeGreaterThan(0);
      expect(outcome).toMatchObject({
        modelProfileId: 'economy',
        modelProfileName: 'Economy',
        model: 'economy-model'
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
