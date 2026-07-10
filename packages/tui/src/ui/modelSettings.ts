import {
  createLlmClientForProvider,
  formatModelEffortLabel,
  getLlmProviderDefinition,
  isUsableLlmConfig,
  listProvidersFromEnv,
  loadKrossConfig,
  THINKING_EFFORT_LEVELS,
  type AgentRuntime,
  type ImportedLlmConfig,
  type LlmClient,
  type LlmProvider,
  type ThinkingEffort
} from '@kross/core';

export type SettingsSection = 'effort' | 'model';

export interface EffortOption {
  id: ThinkingEffort;
  label: string;
}

export interface ModelOption {
  id: string;
  provider: LlmProvider;
  model: string;
  label: string;
  /** Provider has env credentials. */
  configured: boolean;
  current: boolean;
}

export interface ModelSettingsState {
  section: SettingsSection;
  effortIndex: number;
  modelIndex: number;
  efforts: EffortOption[];
  models: ModelOption[];
}

export function buildEffortOptions(
  current: ThinkingEffort
): { options: EffortOption[]; index: number } {
  const options = THINKING_EFFORT_LEVELS.map((id) => ({
    id,
    label: id
  }));
  const index = Math.max(
    0,
    options.findIndex((item) => item.id === current)
  );
  return { options, index };
}

/**
 * Build selectable model rows: current first, then each configured provider.
 * Unconfigured providers appear dimmed and are not selectable targets for apply
 * (filtered out of the actionable list unless current).
 */
export function buildModelOptions(
  client: LlmClient | undefined,
  env: Record<string, string | undefined> = process.env,
  saved?: ImportedLlmConfig
): { options: ModelOption[]; index: number } {
  const currentProvider = client?.provider;
  const currentModel = client?.model?.trim() || '';
  const rows: ModelOption[] = [];
  const seen = new Set<string>();

  if (currentProvider && currentModel) {
    const key = `${currentProvider}::${currentModel}`;
    seen.add(key);
    rows.push({
      id: key,
      provider: currentProvider,
      model: currentModel,
      label: `${currentModel}`,
      configured: true,
      current: true
    });
  }

  // env-configured providers
  for (const row of listProvidersFromEnv(env)) {
    if (!row.configured || !row.model) {
      continue;
    }
    const key = `${row.provider}::${row.model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push({
      id: key,
      provider: row.provider,
      model: row.model,
      label: `${row.model} · ${row.provider}`,
      configured: true,
      current: false
    });
  }

  // kross-saved provider (import) when env lacks keys
  if (saved && isUsableLlmConfig(saved)) {
    const key = `${saved.provider}::${saved.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      rows.push({
        id: key,
        provider: saved.provider,
        model: saved.model,
        label: `${saved.model} · ${saved.provider} (saved)`,
        configured: true,
        current: false
      });
    }
  }

  for (const row of listProvidersFromEnv(env)) {
    const savedCovers =
      saved && isUsableLlmConfig(saved) && saved.provider === row.provider;
    if (row.configured || savedCovers) {
      continue;
    }
    const def = getLlmProviderDefinition(row.provider);
    const model = row.model ?? def.exampleModel;
    const key = `${row.provider}::${model}::unconfigured`;
    rows.push({
      id: key,
      provider: row.provider,
      model,
      label: `${def.exampleModel} · ${row.provider} (未配置)`,
      configured: false,
      current: false
    });
  }

  let index = rows.findIndex((item) => item.current);
  if (index < 0) {
    index = 0;
  }

  return { options: rows, index };
}

export function createModelSettingsState(
  runtime: AgentRuntime,
  env: Record<string, string | undefined> = process.env,
  saved?: ImportedLlmConfig
): ModelSettingsState {
  const effort = buildEffortOptions(runtime.getThinkingEffort());
  const models = buildModelOptions(
    runtime.getLlmClient(),
    env,
    saved ?? loadKrossConfig()?.llm
  );
  return {
    section: 'effort',
    effortIndex: effort.index,
    modelIndex: models.index,
    efforts: effort.options,
    models: models.options
  };
}

export function moveSettingsSelection(
  state: ModelSettingsState,
  direction: 'up' | 'down'
): ModelSettingsState {
  const delta = direction === 'up' ? -1 : 1;
  if (state.section === 'effort') {
    const len = state.efforts.length;
    if (len === 0) {
      return state;
    }
    return {
      ...state,
      effortIndex: (state.effortIndex + delta + len) % len
    };
  }
  const selectable = selectableModelIndexes(state.models);
  if (selectable.length === 0) {
    return state;
  }
  const pos = selectable.indexOf(state.modelIndex);
  const nextPos =
    pos < 0
      ? 0
      : (pos + delta + selectable.length) % selectable.length;
  return {
    ...state,
    modelIndex: selectable[nextPos] ?? 0
  };
}

export function switchSettingsSection(
  state: ModelSettingsState,
  section: SettingsSection
): ModelSettingsState {
  if (state.section === section) {
    return state;
  }
  // When entering model section, snap index onto a selectable row.
  if (section === 'model') {
    const selectable = selectableModelIndexes(state.models);
    const modelIndex = selectable.includes(state.modelIndex)
      ? state.modelIndex
      : (selectable[0] ?? 0);
    return { ...state, section, modelIndex };
  }
  return { ...state, section };
}

export type ApplySettingsResult =
  | { ok: true; label: string; summary: string }
  | { ok: false; message: string };

/**
 * Apply the currently highlighted effort + model selection to the runtime.
 */
export function applyModelSettings(
  runtime: AgentRuntime,
  state: ModelSettingsState,
  env: Record<string, string | undefined> = process.env,
  saved?: ImportedLlmConfig
): ApplySettingsResult {
  const effort = state.efforts[state.effortIndex]?.id;
  if (!effort) {
    return { ok: false, message: '未选择思考强度' };
  }

  const savedLlm = saved ?? loadKrossConfig()?.llm;
  const modelOpt = state.models[state.modelIndex];
  if (!modelOpt) {
    try {
      runtime.setThinkingEffort(effort);
      return {
        ok: true,
        label: runtime.getModelLabel(),
        summary: `思考强度 → ${effort}`
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  if (!modelOpt.configured) {
    const def = getLlmProviderDefinition(modelOpt.provider);
    return {
      ok: false,
      message: `${def.name} 未配置密钥（${[...def.apiKeyEnv, ...(def.authTokenEnv ?? [])].join('/')}）`
    };
  }

  try {
    const current = runtime.getLlmClient();
    if (
      current &&
      current.provider === modelOpt.provider &&
      current.model === modelOpt.model
    ) {
      runtime.setThinkingEffort(effort);
    } else if (current && current.provider === modelOpt.provider) {
      runtime.setModel(modelOpt.model);
      runtime.setThinkingEffort(effort);
    } else {
      const client = createLlmClientForProvider(
        modelOpt.provider,
        modelOpt.model,
        env,
        undefined,
        savedLlm
      );
      client.setThinkingEffort?.(effort);
      runtime.setLlmClient(client);
    }

    return {
      ok: true,
      label: formatModelEffortLabel(modelOpt.model, effort),
      summary: `已应用 ${formatModelEffortLabel(modelOpt.model, effort)}`
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function selectableModelIndexes(models: ModelOption[]): number[] {
  return models
    .map((item, index) => (item.configured ? index : -1))
    .filter((index) => index >= 0);
}
