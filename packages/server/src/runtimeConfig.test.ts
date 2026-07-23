import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RuntimeConfigStore } from './runtimeConfig';

describe('RuntimeConfigStore', () => {
  it('persists provider secrets privately and only exposes masked metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-provider-'));
    const path = join(root, 'provider.json');
    const store = new RuntimeConfigStore(path, {});

    expect(store.update({
      provider: 'openai',
      model: 'gpt-test',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'provider-secret'
    })).toEqual({
      provider: 'openai',
      model: 'gpt-test',
      baseUrl: 'https://api.example.com/v1',
      hasApiKey: true,
      source: 'saved'
    });
    expect(store.workerEnvironment()).toMatchObject({
      AGENT_LLM_PROVIDER: 'openai',
      AGENT_LLM_MODEL: 'gpt-test',
      OPENAI_API_KEY: 'provider-secret',
      OPENAI_MODEL: 'gpt-test'
    });
    expect(JSON.stringify(store.publicProvider())).not.toContain(
      'provider-secret'
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('provider-secret');

    const restored = new RuntimeConfigStore(path, {});
    restored.update({ provider: 'openai', model: 'gpt-next' });
    expect(restored.workerEnvironment().OPENAI_API_KEY).toBe(
      'provider-secret'
    );
  });

  it('reports environment-backed provider configuration without exposing keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-provider-env-'));
    const store = new RuntimeConfigStore(join(root, 'provider.json'), {
      AGENT_LLM_PROVIDER: 'anthropic',
      ANTHROPIC_MODEL: 'claude-test',
      ANTHROPIC_API_KEY: 'secret'
    });

    expect(store.publicProvider()).toEqual({
      provider: 'anthropic',
      model: 'claude-test',
      baseUrl: undefined,
      hasApiKey: true,
      source: 'environment'
    });
  });
});
