import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createConfigImportController,
  createLlmClientFromKrossConfig,
  discoverExternalAgentConfigs,
  loadKrossConfig,
  mergeLlmConfigPatch,
  saveImportedAgentConfig,
  updateKrossLlmConfig
} from './configImport';

describe('config import', () => {
  it('discovers Codex config from ~/.codex/config.toml and env key', () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.codex'), { recursive: true });
      writeFileSync(
        join(homeDir, '.codex/config.toml'),
        [
          'model = "gpt-5-codex"',
          'model_provider = "openai"',
          '',
          '[model_providers.openai]',
          'base_url = "https://llm.example/v1"',
          'env_key = "OPENAI_API_KEY"'
        ].join('\n')
      );

      const candidates = discoverExternalAgentConfigs({
        homeDir,
        env: { OPENAI_API_KEY: 'codex-key' },
        pathEnv: ''
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        source: 'codex',
        displayName: 'Codex',
        detected: true,
        config: {
          provider: 'openai',
          apiKey: 'codex-key',
          baseUrl: 'https://llm.example/v1',
          model: 'gpt-5-codex'
        },
        detectedFrom: expect.arrayContaining(['~/.codex/config.toml'])
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('discovers Claude Code config from ~/.claude/settings.json and env key', () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      writeFileSync(
        join(homeDir, '.claude/settings.json'),
        JSON.stringify({
          model: 'claude-sonnet-4-5',
          env: {
            ANTHROPIC_BASE_URL: 'https://anthropic.example/v1'
          }
        })
      );

      const candidates = discoverExternalAgentConfigs({
        homeDir,
        env: { ANTHROPIC_API_KEY: 'claude-key' },
        pathEnv: ''
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        source: 'claude',
        displayName: 'Claude Code',
        detected: true,
        config: {
          provider: 'anthropic',
          apiKey: 'claude-key',
          baseUrl: 'https://anthropic.example/v1',
          model: 'claude-sonnet-4-5'
        },
        detectedFrom: expect.arrayContaining(['~/.claude/settings.json'])
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('discovers Claude Code auth token and prefers API model over UI alias', () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      writeFileSync(
        join(homeDir, '.claude/settings.json'),
        JSON.stringify({
          model: 'sonnet',
          env: {
            ANTHROPIC_AUTH_TOKEN: 'claude-auth-token',
            ANTHROPIC_BASE_URL: 'https://ark.example/api/coding',
            ANTHROPIC_MODEL: 'GLM-4.5',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'GLM-4.5[1M]'
          }
        })
      );

      const candidates = discoverExternalAgentConfigs({
        homeDir,
        env: {},
        pathEnv: ''
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        source: 'claude',
        config: {
          provider: 'anthropic',
          authToken: 'claude-auth-token',
          baseUrl: 'https://ark.example/api/coding',
          model: 'GLM-4.5'
        }
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('resolves Claude Code model aliases through default model env values', () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      writeFileSync(
        join(homeDir, '.claude/settings.json'),
        JSON.stringify({
          model: 'sonnet',
          env: {
            ANTHROPIC_AUTH_TOKEN: 'claude-auth-token',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-real'
          }
        })
      );

      const candidates = discoverExternalAgentConfigs({
        homeDir,
        env: {},
        pathEnv: ''
      });

      expect(candidates[0]?.config.model).toBe('claude-sonnet-real');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('reoffers import when saved Kross config is missing credentials', () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.kross'), { recursive: true });
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      writeFileSync(
        join(homeDir, '.kross/config.json'),
        JSON.stringify({
          llm: {
            provider: 'anthropic',
            model: 'sonnet',
            baseUrl: 'https://ark.example/api/coding'
          }
        })
      );
      writeFileSync(
        join(homeDir, '.claude/settings.json'),
        JSON.stringify({
          model: 'sonnet',
          env: {
            ANTHROPIC_AUTH_TOKEN: 'claude-auth-token',
            ANTHROPIC_MODEL: 'GLM-4.5'
          }
        })
      );

      const controller = createConfigImportController({ homeDir, env: {}, pathEnv: '' });

      expect(controller.getPrompt()?.candidates.map((candidate) => candidate.source)).toEqual([
        'claude'
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('allows explicit import to replace an existing usable config', () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.kross'), { recursive: true });
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      writeFileSync(
        join(homeDir, '.kross/config.json'),
        JSON.stringify({
          llm: {
            provider: 'openai',
            apiKey: 'old-key',
            model: 'old-model'
          }
        })
      );
      writeFileSync(
        join(homeDir, '.claude/settings.json'),
        JSON.stringify({
          model: 'sonnet',
          env: {
            ANTHROPIC_AUTH_TOKEN: 'claude-auth-token',
            ANTHROPIC_MODEL: 'GLM-4.5'
          }
        })
      );

      const controller = createConfigImportController({ homeDir, env: {}, pathEnv: '' });
      expect(controller.getPrompt()).toBeUndefined();

      const result = controller.importSource('claude');

      expect(result.config.llm).toMatchObject({
        provider: 'anthropic',
        authToken: 'claude-auth-token',
        model: 'GLM-4.5'
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('creates an Anthropic client from saved auth token config', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createLlmClientFromKrossConfig(
      {
        llm: {
          provider: 'anthropic',
          authToken: 'saved-token',
          model: 'GLM-4.5',
          baseUrl: 'https://ark.example/api/coding'
        }
      },
      async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
    );

    await client?.complete({
      messages: [{ role: 'user', content: 'hi' }]
    });

    expect(client).toBeDefined();
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer saved-token'
    });
  });

  it('saves an imported candidate as Kross config and suppresses future prompts', () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.codex'), { recursive: true });
      writeFileSync(
        join(homeDir, '.codex/config.toml'),
        [
          'model = "gpt-5-codex"',
          '',
          '[model_providers.openai]',
          'base_url = "https://llm.example/v1"'
        ].join('\n')
      );
      const candidates = discoverExternalAgentConfigs({
        homeDir,
        env: {
          OPENAI_API_KEY: 'codex-key',
          OPENAI_MODEL: 'gpt-5-codex'
        },
        pathEnv: ''
      });
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      expect(candidate).toBeDefined();

      const result = saveImportedAgentConfig({
        homeDir,
        candidate: candidate!,
        now: () => new Date('2026-07-06T00:00:00.000Z')
      });
      const saved = loadKrossConfig({ homeDir });

      expect(result.configPath).toBe(join(homeDir, '.kross/config.json'));
      expect(saved).toMatchObject({
        llm: {
          provider: 'openai',
          apiKey: 'codex-key',
          baseUrl: 'https://llm.example/v1',
          model: 'gpt-5-codex'
        },
        setup: {
          importedFrom: 'codex',
          importedAt: '2026-07-06T00:00:00.000Z'
        }
      });
      expect(readFileSync(result.configPath, 'utf8')).toContain('"provider": "openai"');
      expect(
        createConfigImportController({ homeDir, env: {}, pathEnv: '' }).getPrompt()
      ).toBeUndefined();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('mergeLlmConfigPatch keeps secrets on same-provider model switch', () => {
    const merged = mergeLlmConfigPatch(
      {
        provider: 'openai',
        apiKey: 'saved-key',
        baseUrl: 'https://saved.example/v1',
        model: 'gpt-old'
      },
      {
        provider: 'openai',
        model: 'gpt-new'
        // no apiKey in patch (env-derived field missing)
      }
    );

    expect(merged).toEqual({
      provider: 'openai',
      model: 'gpt-new',
      apiKey: 'saved-key',
      baseUrl: 'https://saved.example/v1'
    });
  });

  it('mergeLlmConfigPatch does not reuse foreign provider credentials', () => {
    const merged = mergeLlmConfigPatch(
      {
        provider: 'openai',
        apiKey: 'openai-key',
        model: 'gpt-old'
      },
      {
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'ds-key'
      }
    );

    expect(merged).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'ds-key'
    });
  });

  it('updateKrossLlmConfig preserves apiKey when only model changes', () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.kross'), { recursive: true });
      writeFileSync(
        join(homeDir, '.kross/config.json'),
        JSON.stringify({
          llm: {
            provider: 'openai',
            apiKey: 'keep-me',
            model: 'gpt-a',
            baseUrl: 'https://example/v1'
          }
        })
      );

      const result = updateKrossLlmConfig(
        { provider: 'openai', model: 'gpt-b' },
        { homeDir }
      );

      expect(result.config.llm).toEqual({
        provider: 'openai',
        model: 'gpt-b',
        apiKey: 'keep-me',
        baseUrl: 'https://example/v1'
      });
      expect(loadKrossConfig({ homeDir })?.llm?.apiKey).toBe('keep-me');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('offers a two-choice prompt when both Claude Code and Codex are importable', () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.codex'), { recursive: true });
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      writeFileSync(join(homeDir, '.codex/config.toml'), 'model = "gpt-5-codex"\n');
      writeFileSync(
        join(homeDir, '.claude/settings.json'),
        JSON.stringify({ model: 'claude-sonnet-4-5' })
      );

      const controller = createConfigImportController({
        homeDir,
        env: {
          OPENAI_API_KEY: 'codex-key',
          ANTHROPIC_API_KEY: 'claude-key'
        },
        pathEnv: ''
      });

      expect(controller.getPrompt()?.candidates.map((candidate) => candidate.source)).toEqual([
        'claude',
        'codex'
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

function createTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'kross-home-'));
}
