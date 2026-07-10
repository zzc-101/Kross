import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  type LlmClient,
  type TraceEvent,
  type TraceStore
} from '@kross/core';

import {
  applyModelSettings,
  buildEffortOptions,
  buildModelOptions,
  createModelSettingsState,
  moveSettingsSelection,
  switchSettingsSection
} from './modelSettings';

describe('modelSettings', () => {
  it('builds effort options with current index', () => {
    const { options, index } = buildEffortOptions('high');
    expect(options.map((item) => item.id)).toContain('off');
    expect(options[index]?.id).toBe('high');
  });

  it('lists current model and configured providers', () => {
    const client = new StubClient('openai', 'gpt-a');
    const { options, index } = buildModelOptions(client, {
      OPENAI_API_KEY: 'k',
      OPENAI_MODEL: 'gpt-a',
      DEEPSEEK_API_KEY: 'd',
      DEEPSEEK_MODEL: 'deepseek-chat'
    });

    expect(options[index]?.current).toBe(true);
    expect(options.some((item) => item.provider === 'deepseek')).toBe(true);
    expect(
      options.some((item) => item.provider === 'anthropic' && !item.configured)
    ).toBe(true);
  });

  it('moves selection within section and skips unconfigured models', () => {
    let state = createModelSettingsState(
      runtimeWith(new StubClient('openai', 'gpt-a')),
      {
        OPENAI_API_KEY: 'k',
        OPENAI_MODEL: 'gpt-a',
        DEEPSEEK_API_KEY: 'd',
        DEEPSEEK_MODEL: 'deepseek-chat'
      }
    );
    state = switchSettingsSection(state, 'model');
    const first = state.modelIndex;
    state = moveSettingsSelection(state, 'down');
    expect(state.models[state.modelIndex]?.configured).toBe(true);
    expect(state.modelIndex).not.toBe(first);
  });

  it('applies thinking effort without changing model', () => {
    const client = new StubClient('openai', 'gpt-a', 'medium');
    const runtime = runtimeWith(client);
    const state = createModelSettingsState(runtime, {
      OPENAI_API_KEY: 'k',
      OPENAI_MODEL: 'gpt-a'
    });
    const highIndex = state.efforts.findIndex((item) => item.id === 'high');
    const result = applyModelSettings(runtime, {
      ...state,
      section: 'effort',
      effortIndex: highIndex
    });

    expect(result.ok).toBe(true);
    expect(client.thinkingEffort).toBe('high');
    expect(runtime.getModelLabel()).toBe('gpt-a (high)');
  });
});

function runtimeWith(client: LlmClient): AgentRuntime {
  return new AgentRuntime({
    traceStore: new MemoryTraceStore(),
    llmClient: client
  });
}

class MemoryTraceStore implements TraceStore {
  private events: TraceEvent[] = [];
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

class StubClient implements LlmClient {
  constructor(
    readonly provider: 'openai',
    public model: string,
    public thinkingEffort: import('@kross/core').ThinkingEffort = 'medium'
  ) {}

  setModel(model: string): void {
    this.model = model;
  }

  setThinkingEffort(effort: import('@kross/core').ThinkingEffort): void {
    this.thinkingEffort = effort;
  }

  async complete() {
    return {
      provider: this.provider,
      model: this.model,
      text: 'ok',
      raw: {}
    };
  }

  async *stream() {
    yield { type: 'done' as const };
  }
}
