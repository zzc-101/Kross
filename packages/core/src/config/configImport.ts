import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { createLlmClient } from '../llm/createLlmClient';
import type { LlmClient, LlmFetch, LlmProvider } from '../llm/types';

export type ExternalAgentSource = 'claude' | 'codex';

export interface ImportedLlmConfig {
  provider: LlmProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  anthropicVersion?: string;
}

export interface KrossConfig {
  llm?: ImportedLlmConfig;
  setup?: {
    importedFrom?: ExternalAgentSource;
    importedAt?: string;
    importPromptDismissedAt?: string;
  };
}

export interface ExternalAgentConfigCandidate {
  source: ExternalAgentSource;
  displayName: string;
  detected: boolean;
  detectedFrom: string[];
  config: ImportedLlmConfig;
}

export interface ConfigImportPrompt {
  candidates: ExternalAgentConfigCandidate[];
}

export interface ConfigImportResult {
  configPath: string;
  config: KrossConfig;
  candidate: ExternalAgentConfigCandidate;
}

export interface ConfigImportSkipResult {
  configPath: string;
  config: KrossConfig;
}

export interface ConfigImportController {
  getPrompt(): ConfigImportPrompt | undefined;
  importSource(source: ExternalAgentSource): ConfigImportResult;
  skip(): ConfigImportSkipResult;
}

export interface ConfigDiscoveryOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  pathEnv?: string;
}

export interface ConfigPersistenceOptions {
  homeDir?: string;
  krossHome?: string;
}

export interface SaveImportedAgentConfigInput extends ConfigPersistenceOptions {
  candidate: ExternalAgentConfigCandidate;
  now?: () => Date;
}

export interface CreateConfigImportControllerOptions
  extends ConfigDiscoveryOptions,
    ConfigPersistenceOptions {
  now?: () => Date;
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

export function discoverExternalAgentConfigs(
  options: ConfigDiscoveryOptions = {}
): ExternalAgentConfigCandidate[] {
  return [
    discoverClaudeCodeConfig(options),
    discoverCodexConfig(options)
  ].filter(isCandidate);
}

export function createConfigImportController(
  options: CreateConfigImportControllerOptions = {}
): ConfigImportController {
  return {
    getPrompt() {
      const existing = loadKrossConfig(options);
      if (existing?.llm || existing?.setup?.importPromptDismissedAt) {
        return undefined;
      }

      const candidates = discoverExternalAgentConfigs(options);
      return candidates.length > 0 ? { candidates } : undefined;
    },
    importSource(source) {
      const prompt = this.getPrompt();
      const candidate = prompt?.candidates.find((item) => item.source === source);
      if (!candidate) {
        throw new Error(`No importable config for source: ${source}`);
      }
      return saveImportedAgentConfig({
        ...options,
        candidate,
        now: options.now
      });
    },
    skip() {
      return markConfigImportSkipped(options);
    }
  };
}

export function saveImportedAgentConfig(
  input: SaveImportedAgentConfigInput
): ConfigImportResult {
  const configPath = resolveKrossConfigPath(input);
  const config: KrossConfig = {
    ...loadKrossConfig(input),
    llm: input.candidate.config,
    setup: {
      ...loadKrossConfig(input)?.setup,
      importedFrom: input.candidate.source,
      importedAt: (input.now ?? (() => new Date()))().toISOString()
    }
  };
  writeKrossConfig(configPath, config);

  return {
    configPath,
    config,
    candidate: input.candidate
  };
}

export function markConfigImportSkipped(
  options: CreateConfigImportControllerOptions = {}
): ConfigImportSkipResult {
  const configPath = resolveKrossConfigPath(options);
  const config: KrossConfig = {
    ...loadKrossConfig(options),
    setup: {
      ...loadKrossConfig(options)?.setup,
      importPromptDismissedAt: (options.now ?? (() => new Date()))().toISOString()
    }
  };
  writeKrossConfig(configPath, config);

  return { configPath, config };
}

export function loadKrossConfig(
  options: ConfigPersistenceOptions = {}
): KrossConfig | undefined {
  const configPath = resolveKrossConfigPath(options);
  if (!existsSync(configPath)) {
    return undefined;
  }

  return readJsonFile<KrossConfig>(configPath);
}

export function createLlmClientFromKrossConfig(
  config: KrossConfig | undefined,
  fetch?: LlmFetch
): LlmClient | undefined {
  const llm = config?.llm;
  if (!llm?.apiKey || !llm.model) {
    return undefined;
  }

  return createLlmClient({
    provider: llm.provider,
    apiKey: llm.apiKey,
    model: llm.model,
    baseUrl: llm.baseUrl,
    anthropicVersion: llm.anthropicVersion,
    fetch
  });
}

export function resolveKrossConfigPath(
  options: ConfigPersistenceOptions = {}
): string {
  const root = options.krossHome ?? join(options.homeDir ?? homedir(), '.kross');
  return join(root, 'config.json');
}

function discoverCodexConfig(
  options: ConfigDiscoveryOptions
): ExternalAgentConfigCandidate | undefined {
  const homeDir = options.homeDir ?? homedir();
  const configPath = join(homeDir, '.codex/config.toml');
  const authPath = join(homeDir, '.codex/auth.json');
  const detectedFrom: string[] = [];
  const values = existsSync(configPath)
    ? parseFlatToml(readFileSync(configPath, 'utf8'))
    : {};

  if (existsSync(configPath)) {
    detectedFrom.push('~/.codex/config.toml');
  }
  if (existsSync(authPath)) {
    detectedFrom.push('~/.codex/auth.json');
  }
  if (pathContainsCommand(options.pathEnv, 'codex')) {
    detectedFrom.push('PATH:codex');
  }
  if (detectedFrom.length === 0) {
    return undefined;
  }

  const providerName = values.model_provider ?? 'openai';
  const providerPrefix = `model_providers.${providerName}`;
  const auth = existsSync(authPath) ? readJsonFile<Record<string, unknown>>(authPath) : undefined;
  const model = firstString(
    values.model,
    options.env?.OPENAI_MODEL,
    values[`${providerPrefix}.model`]
  );
  if (!model) {
    return undefined;
  }

  return {
    source: 'codex',
    displayName: 'Codex',
    detected: true,
    detectedFrom,
    config: {
      provider: 'openai',
      apiKey: firstString(
        options.env?.OPENAI_API_KEY,
        values[`${providerPrefix}.api_key`],
        valueFromJson(auth, 'OPENAI_API_KEY'),
        valueFromJson(auth, 'api_key'),
        valueFromJson(auth, 'apiKey')
      ),
      baseUrl:
        firstString(
          values[`${providerPrefix}.base_url`],
          values[`${providerPrefix}.baseUrl`],
          options.env?.OPENAI_BASE_URL
        ) ?? DEFAULT_OPENAI_BASE_URL,
      model
    }
  };
}

function discoverClaudeCodeConfig(
  options: ConfigDiscoveryOptions
): ExternalAgentConfigCandidate | undefined {
  const homeDir = options.homeDir ?? homedir();
  const settingsPath = join(homeDir, '.claude/settings.json');
  const rootPath = join(homeDir, '.claude.json');
  const detectedFrom: string[] = [];
  const settings = existsSync(settingsPath)
    ? readJsonFile<Record<string, unknown>>(settingsPath)
    : undefined;
  const root = existsSync(rootPath) ? readJsonFile<Record<string, unknown>>(rootPath) : undefined;
  const settingsEnv = isRecord(settings?.env) ? settings.env : undefined;

  if (existsSync(settingsPath)) {
    detectedFrom.push('~/.claude/settings.json');
  }
  if (existsSync(rootPath)) {
    detectedFrom.push('~/.claude.json');
  }
  if (pathContainsCommand(options.pathEnv, 'claude')) {
    detectedFrom.push('PATH:claude');
  }
  if (detectedFrom.length === 0) {
    return undefined;
  }

  const model = firstString(
    valueFromJson(settings, 'model'),
    valueFromJson(settingsEnv, 'ANTHROPIC_MODEL'),
    options.env?.ANTHROPIC_MODEL,
    valueFromJson(root, 'model')
  );
  if (!model) {
    return undefined;
  }

  return {
    source: 'claude',
    displayName: 'Claude Code',
    detected: true,
    detectedFrom,
    config: {
      provider: 'anthropic',
      apiKey: firstString(
        options.env?.ANTHROPIC_API_KEY,
        valueFromJson(settingsEnv, 'ANTHROPIC_API_KEY'),
        valueFromJson(settings, 'apiKey'),
        valueFromJson(settings, 'api_key')
      ),
      baseUrl:
        firstString(
          valueFromJson(settingsEnv, 'ANTHROPIC_BASE_URL'),
          valueFromJson(settings, 'baseUrl'),
          valueFromJson(settings, 'base_url'),
          options.env?.ANTHROPIC_BASE_URL
        ) ?? DEFAULT_ANTHROPIC_BASE_URL,
      model,
      anthropicVersion: firstString(
        options.env?.ANTHROPIC_VERSION,
        valueFromJson(settingsEnv, 'ANTHROPIC_VERSION')
      )
    }
  };
}

function writeKrossConfig(configPath: string, config: KrossConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function parseFlatToml(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  let section = '';

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1].trim();
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch?.[1] || keyMatch[2] === undefined) {
      continue;
    }

    const key = section ? `${section}.${keyMatch[1]}` : keyMatch[1];
    values[key] = parseTomlScalar(keyMatch[2]);
  }

  return values;
}

function parseTomlScalar(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, '').trim();
  const quoted = withoutComment.match(/^"([\s\S]*)"$/);
  if (quoted?.[1] !== undefined) {
    return quoted[1].replace(/\\"/g, '"');
  }
  const singleQuoted = withoutComment.match(/^'([\s\S]*)'$/);
  return singleQuoted?.[1] ?? withoutComment;
}

function pathContainsCommand(pathEnv: string | undefined, command: string): boolean {
  if (!pathEnv) {
    return false;
  }

  return pathEnv.split(delimiter).some((dir) => {
    if (!dir) {
      return false;
    }
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function valueFromJson(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCandidate(
  candidate: ExternalAgentConfigCandidate | undefined
): candidate is ExternalAgentConfigCandidate {
  return candidate !== undefined;
}
