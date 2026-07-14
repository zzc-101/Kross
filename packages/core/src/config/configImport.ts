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

import { isAppLocale, type AppLocale } from '../i18n';
import { createLlmClient } from '../llm/createLlmClient';
import { isLlmProvider } from '../llm/llmProviders';
import { isUsableLlmConfig } from '../llm/resolveCredentials';
import type { ThinkingEffort } from '../llm/thinkingEffort';
import type { LlmClient, LlmFetch, LlmProvider } from '../llm/types';

export type ExternalAgentSource = 'claude' | 'codex';

export interface ImportedLlmConfig {
  provider: LlmProvider;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  model: string;
  anthropicVersion?: string;
  thinkingEffort?: ThinkingEffort;
  /** 模型上下文窗口 token 数；未设置时统一使用 256K。 */
  contextWindow?: number;
}

export interface KrossConfig {
  /** UI language preference (`zh` | `en`). */
  locale?: AppLocale;
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
      if (
        isUsableImportedLlmConfig(existing?.llm) ||
        existing?.setup?.importPromptDismissedAt
      ) {
        return undefined;
      }

      const candidates = discoverExternalAgentConfigs(options);
      return candidates.length > 0 ? { candidates } : undefined;
    },
    importSource(source) {
      const candidate = discoverExternalAgentConfigs(options).find(
        (item) => item.source === source
      );
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
  const existing = loadKrossConfig(input);
  const config: KrossConfig = {
    ...existing,
    llm: {
      ...input.candidate.config,
      ...(existing?.llm?.contextWindow !== undefined
        ? { contextWindow: existing.llm.contextWindow }
        : {})
    },
    setup: {
      ...existing?.setup,
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
  if (!isUsableImportedLlmConfig(llm) || !isLlmProvider(llm.provider)) {
    return undefined;
  }

  if (llm.provider === 'anthropic') {
    return createLlmClient({
      provider: 'anthropic',
      apiKey: llm.apiKey,
      authToken: llm.authToken,
      model: llm.model,
      baseUrl: llm.baseUrl,
      anthropicVersion: llm.anthropicVersion,
      thinkingEffort: llm.thinkingEffort,
      contextWindow: llm.contextWindow,
      fetch
    });
  }

  if (!llm.apiKey) {
    return undefined;
  }

  return createLlmClient({
    provider: llm.provider,
    apiKey: llm.apiKey,
    model: llm.model,
    baseUrl: llm.baseUrl,
    thinkingEffort: llm.thinkingEffort,
    contextWindow: llm.contextWindow,
    fetch
  });
}

/**
 * Persist active provider/model into ~/.kross/config.json.
 *
 * Credential fields only overwrite when the patch provides a non-empty value.
 * Same-provider updates keep existing secrets. Refuses to write a config that
 * would become unusable (no secrets), so import-saved keys cannot be wiped by
 * env-less /model or settings-panel applies.
 */
export function updateKrossLlmConfig(
  patch: Partial<ImportedLlmConfig> &
    Pick<ImportedLlmConfig, 'provider' | 'model'>,
  options: ConfigPersistenceOptions = {}
): { configPath: string; config: KrossConfig } {
  const configPath = resolveKrossConfigPath(options);
  const existingFile = loadKrossConfig(options);
  const existing = existingFile?.llm;
  const merged = mergeLlmConfigPatch(existing, patch);

  if (!isUsableLlmConfig(merged)) {
    throw new Error(
      '拒绝写入无密钥的模型配置（会覆盖已有凭证）。请保留 env 密钥或重新 /import。'
    );
  }

  const config: KrossConfig = {
    ...existingFile,
    llm: merged
  };
  writeKrossConfig(configPath, config);
  return { configPath, config };
}

/** Persist UI locale into ~/.kross/config.json (best-effort preference). */
export function updateKrossLocale(
  locale: AppLocale,
  options: ConfigPersistenceOptions = {}
): { configPath: string; config: KrossConfig } {
  if (!isAppLocale(locale)) {
    throw new Error(`unsupported locale: ${String(locale)}`);
  }
  const configPath = resolveKrossConfigPath(options);
  const existing = loadKrossConfig(options);
  const config: KrossConfig = {
    ...existing,
    locale
  };
  writeKrossConfig(configPath, config);
  return { configPath, config };
}

export function mergeLlmConfigPatch(
  existing: ImportedLlmConfig | undefined,
  patch: Partial<ImportedLlmConfig> &
    Pick<ImportedLlmConfig, 'provider' | 'model'>
): ImportedLlmConfig {
  const sameProvider = existing?.provider === patch.provider;
  const llm: ImportedLlmConfig = {
    provider: patch.provider,
    model: patch.model
  };

  // Prefer patch secrets; otherwise keep existing secrets when same provider.
  // When provider changes, only patch secrets apply (do not leak foreign keys).
  const apiKey = firstNonEmpty(
    patch.apiKey,
    sameProvider ? existing?.apiKey : undefined
  );
  if (apiKey !== undefined) {
    llm.apiKey = apiKey;
  }

  const baseUrl = firstNonEmpty(
    patch.baseUrl,
    sameProvider ? existing?.baseUrl : undefined
  );
  if (baseUrl !== undefined) {
    llm.baseUrl = baseUrl;
  }

  if (patch.provider === 'anthropic') {
    const authToken = firstNonEmpty(
      patch.authToken,
      sameProvider ? existing?.authToken : undefined
    );
    if (authToken !== undefined) {
      llm.authToken = authToken;
    }
    const anthropicVersion = firstNonEmpty(
      patch.anthropicVersion,
      sameProvider ? existing?.anthropicVersion : undefined
    );
    if (anthropicVersion !== undefined) {
      llm.anthropicVersion = anthropicVersion;
    }
  }

  const thinkingEffort = patch.thinkingEffort ?? existing?.thinkingEffort;
  if (thinkingEffort !== undefined) {
    llm.thinkingEffort = thinkingEffort;
  }

  const contextWindow = normalizePositiveInt(
    patch.contextWindow ?? existing?.contextWindow
  );
  if (contextWindow !== undefined) {
    llm.contextWindow = contextWindow;
  }

  return llm;
}

function normalizePositiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
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

  const configuredModel = firstString(
    options.env?.ANTHROPIC_MODEL,
    valueFromJson(settingsEnv, 'ANTHROPIC_MODEL')
  );
  const uiModel = firstString(
    valueFromJson(settings, 'model'),
    valueFromJson(root, 'model')
  );
  const model =
    configuredModel ??
    resolveClaudeCodeModelAlias(uiModel, options.env, settingsEnv) ??
    uiModel;
  if (!model) {
    return undefined;
  }

  const apiKey = firstString(
    options.env?.ANTHROPIC_API_KEY,
    valueFromJson(settingsEnv, 'ANTHROPIC_API_KEY'),
    valueFromJson(settings, 'apiKey'),
    valueFromJson(settings, 'api_key')
  );
  const authToken = firstString(
    options.env?.ANTHROPIC_AUTH_TOKEN,
    valueFromJson(settingsEnv, 'ANTHROPIC_AUTH_TOKEN'),
    valueFromJson(settings, 'authToken'),
    valueFromJson(settings, 'auth_token')
  );

  return {
    source: 'claude',
    displayName: 'Claude Code',
    detected: true,
    detectedFrom,
    config: {
      provider: 'anthropic',
      apiKey,
      authToken,
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

function resolveClaudeCodeModelAlias(
  model: string | undefined,
  env: Record<string, string | undefined> | undefined,
  settingsEnv: Record<string, unknown> | undefined
): string | undefined {
  const alias = model?.trim().toLowerCase();
  if (!alias || !['haiku', 'sonnet', 'opus'].includes(alias)) {
    return undefined;
  }

  const envKey = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;
  const envNameKey = `${envKey}_NAME`;
  return firstString(
    env?.[envKey],
    env?.[envNameKey],
    valueFromJson(settingsEnv, envKey),
    valueFromJson(settingsEnv, envNameKey)
  );
}

function isUsableImportedLlmConfig(
  config: ImportedLlmConfig | undefined
): config is ImportedLlmConfig {
  return isUsableLlmConfig(config) && isLlmProvider(config.provider);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCandidate(
  candidate: ExternalAgentConfigCandidate | undefined
): candidate is ExternalAgentConfigCandidate {
  return candidate !== undefined && isUsableImportedLlmConfig(candidate.config);
}
