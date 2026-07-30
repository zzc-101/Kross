import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createConfigImportController,
  createLlmClientFromKrossConfig,
  discoverExternalAgentConfigs,
  getActiveKrossModelProfile,
  listKrossModelProfiles,
  loadKrossConfig,
  mergeLlmConfigPatch,
  saveImportedAgentConfig,
  setActiveKrossModelProfile,
  updateActiveKrossModelProfile,
  upsertKrossPublicModelProfile,
  upsertKrossModelProfile
} from './configImport';

describe('config import', () => {
  it('generates profile ids from names without provider prefixes', () => {
    const homeDir = createTempHome();
    try {
      const named = upsertKrossModelProfile(
        {
          name: 'Main Model',
          model: {
            provider: 'anthropic',
            authToken: 'anthropic-token',
            model: 'GLM-5.2'
          }
        },
        { homeDir }
      );
      const unicode = upsertKrossModelProfile(
        {
          name: '经济模型',
          model: {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-economy'
          }
        },
        { homeDir }
      );

      expect(named.profile.id).toBe('main-model');
      expect(unicode.profile.id).toMatch(/^profile-[a-f0-9]{8}$/);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('stores multiple model profiles and switches the active model', () => {
    const homeDir = createTempHome();
    try {
      const first = upsertKrossModelProfile(
        {
          profileId: 'primary',
          name: 'Primary',
          model: {
            provider: 'openai',
            apiKey: 'openai-key',
            baseUrl: 'https://openai.example/v1',
            model: 'gpt-primary',
            contextWindow: 200_000
          }
        },
        { homeDir }
      );
      upsertKrossModelProfile(
        {
          profileId: 'economy',
          name: 'Economy',
          model: {
            provider: 'anthropic',
            apiKey: 'anthropic-key',
            baseUrl: 'https://anthropic.example',
            model: 'claude-economy',
            contextWindow: 100_000
          }
        },
        { homeDir }
      );

      let config = loadKrossConfig({ homeDir });
      expect(listKrossModelProfiles(config)).toHaveLength(2);
      expect(config?.models?.activeProfileId).toBe('economy');
      expect(createLlmClientFromKrossConfig(config)).toMatchObject({
        provider: 'anthropic',
        model: 'claude-economy',
        contextWindow: 100_000
      });

      setActiveKrossModelProfile(first.profile.id, 'high', { homeDir });
      config = loadKrossConfig({ homeDir });
      expect(config?.models?.activeProfileId).toBe('primary');
      expect(getActiveKrossModelProfile(config)).toMatchObject({
        id: 'primary',
        provider: 'openai',
        model: 'gpt-primary',
        thinkingEffort: 'high'
      });
      expect(createLlmClientFromKrossConfig(config)).toMatchObject({
        provider: 'openai',
        model: 'gpt-primary'
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('updates the active model profile without a compatibility mirror', () => {
    const homeDir = createTempHome();
    try {
      const configDir = join(homeDir, '.kross');
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          models: {
            activeProfileId: 'primary',
            profiles: [
              {
                id: 'primary',
                name: 'Primary',
                provider: 'openai',
                apiKey: 'profile-key',
                model: 'gpt-before'
              }
            ]
          }
        })
      );

      updateActiveKrossModelProfile(
        { provider: 'openai', model: 'gpt-after' },
        { homeDir }
      );

      const config = loadKrossConfig({ homeDir });
      expect(config?.models?.profiles[0]).toMatchObject({
        id: 'primary',
        apiKey: 'profile-key',
        model: 'gpt-after'
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('adds a version on write and rejects future or legacy single-model configs', () => {
    const homeDir = createTempHome();
    try {
      const configDir = join(homeDir, '.kross');
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, 'config.json');
      upsertKrossModelProfile(
        {
          name: 'Primary',
          model: {
            provider: 'openai',
            apiKey: 'profile-key',
            model: 'gpt-primary'
          }
        },
        { homeDir }
      );
      expect(JSON.parse(readFileSync(configPath, 'utf8')).version).toBe(1);

      writeFileSync(configPath, JSON.stringify({ version: 2 }));
      expect(() => loadKrossConfig({ homeDir })).toThrow(
        '使用不受支持的数据版本 2'
      );

      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          llm: {
            provider: 'openai',
            apiKey: 'legacy-key',
            model: 'legacy-model'
          }
        })
      );
      expect(() => loadKrossConfig({ homeDir })).toThrow(
        '已移除的单模型 llm 字段'
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

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
          models: {
            activeProfileId: 'incomplete',
            profiles: [
              {
                id: 'incomplete',
                name: 'Incomplete',
                provider: 'anthropic',
                model: 'sonnet',
                baseUrl: 'https://ark.example/api/coding'
              }
            ]
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
          models: {
            activeProfileId: 'existing',
            profiles: [
              {
                id: 'existing',
                name: 'Existing',
                provider: 'openai',
                apiKey: 'old-key',
                model: 'old-model'
              }
            ]
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

      expect(getActiveKrossModelProfile(result.config)).toMatchObject({
        id: 'imported-claude',
        name: 'Claude Code',
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
        models: {
          activeProfileId: 'saved',
          profiles: [
            {
              id: 'saved',
              name: 'Saved',
              provider: 'anthropic',
              authToken: 'saved-token',
              model: 'GLM-4.5',
              baseUrl: 'https://ark.example/api/coding'
            }
          ]
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
        models: {
          activeProfileId: 'imported-codex',
          profiles: [
            {
              id: 'imported-codex',
              name: 'Codex',
              provider: 'openai',
              apiKey: 'codex-key',
              baseUrl: 'https://llm.example/v1',
              model: 'gpt-5-codex'
            }
          ]
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

  it('updateActiveKrossModelProfile preserves apiKey when only model changes', () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.kross'), { recursive: true });
      writeFileSync(
        join(homeDir, '.kross/config.json'),
        JSON.stringify({
          models: {
            activeProfileId: 'primary',
            profiles: [
              {
                id: 'primary',
                name: 'Primary',
                provider: 'openai',
                apiKey: 'keep-me',
                model: 'gpt-a',
                baseUrl: 'https://example/v1'
              }
            ]
          }
        })
      );

      const result = updateActiveKrossModelProfile(
        { provider: 'openai', model: 'gpt-b' },
        { homeDir }
      );

      expect(result.profile).toEqual({
        id: 'primary',
        name: 'Primary',
        provider: 'openai',
        model: 'gpt-b',
        apiKey: 'keep-me',
        baseUrl: 'https://example/v1'
      });
      expect(getActiveKrossModelProfile(loadKrossConfig({ homeDir }))?.apiKey)
        .toBe('keep-me');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('updateActiveKrossModelProfile refuses to replace a profile without secrets', () => {
    const homeDir = createTempHome();
    try {
      mkdirSync(join(homeDir, '.kross'), { recursive: true });
      writeFileSync(
        join(homeDir, '.kross/config.json'),
        JSON.stringify({
          models: {
            activeProfileId: 'primary',
            profiles: [
              {
                id: 'primary',
                name: 'Primary',
                provider: 'anthropic',
                authToken: 'secret-token',
                model: 'claude-a'
              }
            ]
          }
        })
      );

      expect(() =>
        updateActiveKrossModelProfile(
          { provider: 'openai', model: 'gpt-b' },
          { homeDir }
        )
      ).toThrow(/缺少可用凭证/);

      // original credentials untouched
      expect(getActiveKrossModelProfile(loadKrossConfig({ homeDir }))).toEqual({
        id: 'primary',
        name: 'Primary',
        provider: 'anthropic',
        authToken: 'secret-token',
        model: 'claude-a'
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('persists a public model reference without copying its shared token', () => {
    const homeDir = createTempHome();
    try {
      const result = upsertKrossPublicModelProfile('public-hy3', 'high', {
        homeDir
      });
      const serialized = readFileSync(result.configPath, 'utf8');

      expect(result.profile).toEqual({
        id: 'public-public-hy3',
        name: 'Hy3 Public',
        provider: 'anthropic',
        model: 'tencent/Hy3',
        publicModelId: 'public-hy3',
        thinkingEffort: 'high'
      });
      expect(serialized).not.toContain('authToken');
      expect(serialized).not.toContain('"llm"');
      expect(createLlmClientFromKrossConfig(result.config)).toMatchObject({
        provider: 'anthropic',
        model: 'tencent/Hy3',
        publicModelId: 'public-hy3'
      });
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
