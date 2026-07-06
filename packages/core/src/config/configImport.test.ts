import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createConfigImportController,
  discoverExternalAgentConfigs,
  loadKrossConfig,
  saveImportedAgentConfig
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
