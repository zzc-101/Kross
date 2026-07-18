import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  createLlmClientForPublicModel,
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
    expect(options.every((item) => item.configured)).toBe(true);
  });

  it('does not expand the provider catalog from a key alone', () => {
    const { options } = buildModelOptions(undefined, {
      OPENAI_API_KEY: 'k'
    });

    expect(options.some((item) => item.provider === 'openai')).toBe(false);
    expect(options.some((item) => item.model === 'gpt-5.6-sol')).toBe(false);
    expect(options.every((item) => item.publicModelId)).toBe(true);
  });

  it('always includes repository-managed public models', () => {
    const { options } = buildModelOptions(undefined, {});

    expect(options).toHaveLength(1);
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publicModelId: 'public-hy3',
          provider: 'anthropic',
          model: 'tencent/Hy3',
          notice: '来源于硅基流动hy3试用，7月21日到期',
          configured: true
        })
      ])
    );
  });

  it('does not treat a public model token as provider-wide credentials', () => {
    const client = createLlmClientForPublicModel('public-hy3');
    const { options } = buildModelOptions(client, {}, {
      provider: 'anthropic',
      model: 'tencent/Hy3',
      publicModelId: 'public-hy3'
    });

    expect(options.every((item) => item.publicModelId)).toBe(true);
    expect(options.some((item) => item.model.startsWith('claude-'))).toBe(false);
  });

  it('keeps a local model separate from a public model with the same id', () => {
    const client = new StubClient('anthropic', 'tencent/Hy3');
    const { options, index } = buildModelOptions(client, {});

    expect(
      options.filter((item) => item.model === 'tencent/Hy3')
    ).toHaveLength(2);
    expect(options[index]).toMatchObject({
      current: true,
      model: 'tencent/Hy3'
    });
    expect(options[index]?.publicModelId).toBeUndefined();
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          current: false,
          publicModelId: 'public-hy3',
          model: 'tencent/Hy3'
        })
      ])
    );
  });

  it('opens with model selection focused first', () => {
    const state = createModelSettingsState(
      runtimeWith(new StubClient('openai', 'gpt-a')),
      {}
    );

    expect(state.section).toBe('model');
  });

  it('moves selection within configured models', () => {
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

  it('applies a public model without local provider credentials', () => {
    const runtime = runtimeWith(new StubClient('openai', 'gpt-a'));
    const state = createModelSettingsState(runtime, {});
    const publicIndex = state.models.findIndex(
      (item) => item.publicModelId === 'public-hy3'
    );
    const result = applyModelSettings(runtime, {
      ...state,
      section: 'model',
      modelIndex: publicIndex
    });

    expect(result).toMatchObject({ ok: true, publicModelId: 'public-hy3' });
    expect(runtime.getLlmClient()).toMatchObject({
      provider: 'anthropic',
      model: 'tencent/Hy3',
      publicModelId: 'public-hy3'
    });
  });

  it('can switch from a public model to a separate local model with the same id', () => {
    const runtime = runtimeWith(createLlmClientForPublicModel('public-hy3'));
    const state = createModelSettingsState(runtime, {
      ANTHROPIC_AUTH_TOKEN: 'local-token',
      ANTHROPIC_MODEL: 'tencent/Hy3'
    });
    const localIndex = state.models.findIndex(
      (item) => item.model === 'tencent/Hy3' && !item.publicModelId
    );
    const result = applyModelSettings(
      runtime,
      { ...state, modelIndex: localIndex },
      {
        ANTHROPIC_AUTH_TOKEN: 'local-token',
        ANTHROPIC_MODEL: 'tencent/Hy3'
      }
    );

    expect(result.ok).toBe(true);
    expect(runtime.getLlmClient()).toMatchObject({
      provider: 'anthropic',
      model: 'tencent/Hy3'
    });
    expect(runtime.getLlmClient()?.publicModelId).toBeUndefined();
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
    readonly provider: 'openai' | 'anthropic',
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
