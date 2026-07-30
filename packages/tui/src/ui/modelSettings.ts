import {
  createLlmClient,
  createLlmClientForProvider,
  createLlmClientForPublicModel,
  createLlmClientFromKrossModelProfile,
  formatCompactCount,
  formatLlmCapabilities,
  formatModelEffortLabel,
  getLlmProviderDefinition,
  getActiveKrossModelProfile,
  isUsableLlmConfig,
  getPublicModel,
  listKrossModelProfiles,
  listProvidersFromEnv,
  listPublicModels,
  upsertKrossModelProfile,
  t,
  THINKING_EFFORT_LEVELS,
  type AgentRuntime,
  type ImportedLlmConfig,
  type KrossConfig,
  type KrossModelProfile,
  type LlmClient,
  type LlmCapabilities,
  type LlmProvider,
  type ThinkingEffort
} from '@kross/core';

export type SettingsSection = 'effort' | 'model';
export type QuickModelProtocol = 'openai' | 'anthropic';
export type QuickModelSetupStep =
  | 'profileName'
  | 'protocol'
  | 'baseUrl'
  | 'apiKey'
  | 'model'
  | 'contextWindow'
  | 'review';

export const QUICK_MODEL_SETUP_STEPS: readonly QuickModelSetupStep[] = [
  'profileName',
  'protocol',
  'baseUrl',
  'apiKey',
  'model',
  'contextWindow',
  'review'
];

export interface QuickModelSetupState {
  step: QuickModelSetupStep;
  profileName: string;
  protocol: QuickModelProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: string;
  /** First edit on a newly entered field replaces its suggested value. */
  replaceOnInput: boolean;
  error?: string;
}

export interface EffortOption {
  id: ThinkingEffort;
  label: string;
}

export interface ModelOption {
  id: string;
  provider: LlmProvider;
  model: string;
  label: string;
  /** Model has a usable credential source (local, saved, or public catalog). */
  configured: boolean;
  current: boolean;
  publicModelId?: string;
  profileId?: string;
  notice?: string;
}

export interface ModelSettingsState {
  section: SettingsSection;
  effortIndex: number;
  modelIndex: number;
  efforts: EffortOption[];
  models: ModelOption[];
  capabilities?: LlmCapabilities;
  capabilitiesLabel?: string;
  quickSetup?: QuickModelSetupState;
}

export function createQuickModelSetupState(
  runtime: AgentRuntime,
  saved?: ImportedLlmConfig
): QuickModelSetupState {
  const current = runtime.getLlmClient();
  const source = saved;
  const protocol: QuickModelProtocol =
    (source?.provider ?? current?.provider) === 'anthropic'
      ? 'anthropic'
      : 'openai';
  const definition = getLlmProviderDefinition(protocol);
  return {
    step: 'profileName',
    profileName: t('settings.quick.defaultProfileName'),
    protocol,
    baseUrl: source?.baseUrl?.trim() || definition.defaultBaseUrl,
    apiKey: '',
    model: source?.model?.trim() || current?.model?.trim() || definition.exampleModel,
    contextWindow: String(
      source?.contextWindow ?? current?.contextWindow ?? 256_000
    ),
    replaceOnInput: true
  };
}

export function moveQuickModelProtocol(
  state: QuickModelSetupState,
  _direction: 'left' | 'right' | 'up' | 'down'
): QuickModelSetupState {
  const protocol: QuickModelProtocol =
    state.protocol === 'openai' ? 'anthropic' : 'openai';
  const previousDefault = getLlmProviderDefinition(state.protocol).defaultBaseUrl;
  const nextDefault = getLlmProviderDefinition(protocol).defaultBaseUrl;
  return {
    ...state,
    protocol,
    baseUrl:
      !state.baseUrl.trim() || state.baseUrl === previousDefault
        ? nextDefault
        : state.baseUrl,
    replaceOnInput: true,
    error: undefined
  };
}

export function updateQuickModelField(
  state: QuickModelSetupState,
  operation: { append?: string; backspace?: boolean }
): QuickModelSetupState {
  if (state.step === 'protocol' || state.step === 'review') {
    return state;
  }
  const field = state.step;
  const current = state[field];
  const next = operation.backspace
    ? state.replaceOnInput
      ? ''
      : current.slice(0, -1)
    : state.replaceOnInput
      ? operation.append ?? ''
      : `${current}${operation.append ?? ''}`;
  return {
    ...state,
    [field]: next,
    replaceOnInput: false,
    error: undefined
  };
}

export function advanceQuickModelSetup(
  state: QuickModelSetupState,
  saved?: ImportedLlmConfig
): QuickModelSetupState {
  const error = validateQuickModelSetupStep(state, saved);
  if (error) {
    return { ...state, error };
  }
  const index = QUICK_MODEL_SETUP_STEPS.indexOf(state.step);
  return {
    ...state,
    step: QUICK_MODEL_SETUP_STEPS[Math.min(index + 1, QUICK_MODEL_SETUP_STEPS.length - 1)]!,
    replaceOnInput: true,
    error: undefined
  };
}

export function retreatQuickModelSetup(
  state: QuickModelSetupState
): QuickModelSetupState | undefined {
  const index = QUICK_MODEL_SETUP_STEPS.indexOf(state.step);
  if (index <= 0) {
    return undefined;
  }
  return {
    ...state,
    step: QUICK_MODEL_SETUP_STEPS[index - 1]!,
    replaceOnInput: true,
    error: undefined
  };
}

export function validateQuickModelSetupStep(
  state: QuickModelSetupState,
  saved?: ImportedLlmConfig
): string | undefined {
  if (
    (state.step === 'profileName' || state.step === 'review') &&
    !state.profileName.trim()
  ) {
    return t('settings.quick.profileNameRequired');
  }
  if (state.step === 'baseUrl' || state.step === 'review') {
    const value = state.baseUrl.trim();
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return t('settings.quick.invalidBaseUrl');
      }
    } catch {
      return t('settings.quick.invalidBaseUrl');
    }
  }
  if (state.step === 'apiKey' || state.step === 'review') {
    const canReuse =
      saved?.provider === state.protocol &&
      Boolean(saved.apiKey?.trim() || saved.authToken?.trim());
    if (!state.apiKey.trim() && !canReuse) {
      return t('settings.quick.apiKeyRequired');
    }
  }
  if (
    (state.step === 'model' || state.step === 'review') &&
    !state.model.trim()
  ) {
    return t('settings.quick.modelRequired');
  }
  if (state.step === 'contextWindow' || state.step === 'review') {
    const value = Number(state.contextWindow.trim());
    if (!Number.isSafeInteger(value) || value <= 0) {
      return t('settings.quick.invalidContext');
    }
  }
  return undefined;
}

export function applyQuickModelSetup(
  runtime: AgentRuntime,
  state: QuickModelSetupState,
  saved?: ImportedLlmConfig,
  persistence: { homeDir?: string; krossHome?: string } = {}
): ApplySettingsResult {
  const error = validateQuickModelSetupStep(
    { ...state, step: 'review' },
    saved
  );
  if (error) {
    return { ok: false, message: error };
  }
  const sameProtocol = saved?.provider === state.protocol;
  const enteredKey = state.apiKey.trim();
  const apiKey = enteredKey || (sameProtocol ? saved?.apiKey?.trim() : undefined);
  const authToken =
    !enteredKey && sameProtocol ? saved?.authToken?.trim() : undefined;
  const model = state.model.trim();
  const baseUrl = state.baseUrl.trim();
  const contextWindow = Number(state.contextWindow.trim());
  const thinkingEffort = runtime.getThinkingEffort();

  try {
    const client =
      state.protocol === 'anthropic'
        ? createLlmClient({
            provider: 'anthropic',
            model,
            baseUrl,
            contextWindow,
            thinkingEffort,
            ...(apiKey ? { apiKey } : {}),
            ...(authToken ? { authToken } : {})
          })
        : createLlmClient({
            provider: 'openai',
            apiKey: apiKey!,
            model,
            baseUrl,
            contextWindow,
            thinkingEffort
          });
    const savedProfile = upsertKrossModelProfile(
      {
        name: state.profileName.trim(),
        model: {
          provider: state.protocol,
          model,
          baseUrl,
          contextWindow,
          thinkingEffort,
          ...(apiKey ? { apiKey } : {}),
          ...(authToken ? { authToken } : {})
        }
      },
      persistence
    );
    runtime.setLlmClient(client);
    const label = formatModelEffortLabel(model, thinkingEffort);
    return {
      ok: true,
      label,
      summary: t('settings.quick.saved', { label }),
      profileId: savedProfile.profile.id
    };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause)
    };
  }
}

export function buildEffortOptions(
  current: ThinkingEffort,
  thinkingSupported = true
): { options: EffortOption[]; index: number } {
  const levels = thinkingSupported ? THINKING_EFFORT_LEVELS : (['off'] as const);
  const options = levels.map((id) => ({
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
 * Build selectable model rows: current first, repository-managed public models,
 * then models backed by configured provider credentials.
 */
export function buildModelOptions(
  client: LlmClient | undefined,
  env: Record<string, string | undefined> = process.env,
  saved?: ImportedLlmConfig,
  profiles: KrossModelProfile[] = [],
  activeProfileId?: string
): { options: ModelOption[]; index: number } {
  const currentProvider = client?.provider;
  const currentModel = client?.model?.trim() || '';
  const rows: ModelOption[] = [];
  const seen = new Set<string>();
  // Public and locally configured models remain distinct even when they share
  // the same provider/model pair. Only an explicit public model id identifies
  // the current client as repository-managed public access.
  const currentPublic = getPublicModel(client?.publicModelId);
  const activeProfile = activeProfileId
    ? profiles.find(
        (profile) =>
          profile.id === activeProfileId &&
          profile.provider === currentProvider &&
          profile.model === currentModel
      )
    : undefined;

  if (currentProvider && currentModel) {
    const key = activeProfile
      ? `profile::${activeProfile.id}`
      : currentPublic
        ? `public::${currentPublic.id}`
        : `${currentProvider}::${currentModel}`;
    seen.add(key);
    if (activeProfile?.publicModelId) {
      seen.add(`public::${activeProfile.publicModelId}`);
    }
    rows.push({
      id: key,
      provider: currentProvider,
      model: currentModel,
      label: activeProfile
        ? `${activeProfile.name} · ${currentModel} · ${currentProvider}`
        : currentPublic
          ? `${currentPublic.name} · ${t('settings.public')}`
          : `${currentModel}`,
      configured: true,
      current: true,
      ...(activeProfile
        ? {
            profileId: activeProfile.id,
            ...(currentPublic?.notice ? { notice: currentPublic.notice } : {})
          }
        : currentPublic
          ? {
              publicModelId: currentPublic.id,
              notice: currentPublic.notice
            }
          : {})
    });
  }

  for (const profile of profiles) {
    const key = `profile::${profile.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (profile.publicModelId) {
      seen.add(`public::${profile.publicModelId}`);
    }
    rows.push({
      id: key,
      provider: profile.provider,
      model: profile.model,
      label: `${profile.name} · ${profile.model} · ${profile.provider}`,
      configured: true,
      current: profile.id === activeProfile?.id,
      profileId: profile.id
    });
  }

  for (const definition of listPublicModels()) {
    const key = `public::${definition.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push({
      id: key,
      provider: definition.provider,
      model: definition.model,
      label: `${definition.name} · ${t('settings.public')} · ${formatCompactCount(definition.contextWindow ?? 256_000)}`,
      configured: true,
      current: false,
      publicModelId: definition.id,
      notice: definition.notice
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
  if (
    profiles.length === 0 &&
    saved &&
    !saved.publicModelId &&
    isUsableLlmConfig(saved)
  ) {
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

  let index = rows.findIndex((item) => item.current);
  if (index < 0) {
    index = 0;
  }

  return { options: rows, index };
}

export function createModelSettingsState(
  runtime: AgentRuntime,
  env: Record<string, string | undefined> = process.env,
  saved?: ImportedLlmConfig,
  config?: KrossConfig
): ModelSettingsState {
  const savedConfig = config;
  const capabilities = runtime.getLlmCapabilities();
  const effort = buildEffortOptions(
    runtime.getThinkingEffort(),
    capabilities?.thinking !== false
  );
  const profiles = listKrossModelProfiles(savedConfig);
  const activeProfileId = savedConfig?.models?.activeProfileId;
  const models = buildModelOptions(
    runtime.getLlmClient(),
    env,
    saved ?? getActiveKrossModelProfile(savedConfig),
    profiles,
    activeProfileId
  );
  return {
    section: 'model',
    effortIndex: effort.index,
    modelIndex: models.index,
    efforts: effort.options,
    models: models.options,
    capabilities,
    capabilitiesLabel: formatLlmCapabilities(capabilities)
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
  | {
      ok: true;
      label: string;
      summary: string;
      publicModelId?: string;
      profileId?: string;
    }
  | { ok: false; message: string };

/**
 * Apply the currently highlighted effort + model selection to the runtime.
 */
export function applyModelSettings(
  runtime: AgentRuntime,
  state: ModelSettingsState,
  env: Record<string, string | undefined> = process.env,
  saved?: ImportedLlmConfig,
  profiles: KrossModelProfile[] = []
): ApplySettingsResult {
  const effort = state.efforts[state.effortIndex]?.id;
  if (!effort) {
    return { ok: false, message: t('settings.noEffort') };
  }

  const savedLlm = saved;
  const modelOpt = state.models[state.modelIndex];
  if (!modelOpt) {
    try {
      runtime.setThinkingEffort(effort);
      return {
        ok: true,
        label: runtime.getModelLabel(),
        summary: t('settings.effortOnly', { effort })
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
      message: t('settings.missingKey', {
        name: def.name,
        envs: [...def.apiKeyEnv, ...(def.authTokenEnv ?? [])].join('/')
      })
    };
  }

  try {
    const current = runtime.getLlmClient();
    if (modelOpt.profileId) {
      const profile = profiles.find((item) => item.id === modelOpt.profileId);
      const client = createLlmClientFromKrossModelProfile(
        profile ? { ...profile, thinkingEffort: effort } : undefined
      );
      if (!profile || !client) {
        return {
          ok: false,
          message: `模型档案不可用：${modelOpt.profileId}`
        };
      }
      runtime.setLlmClient(client);
    } else if (modelOpt.publicModelId) {
      const client = createLlmClientForPublicModel(modelOpt.publicModelId, {
        thinkingEffort: effort
      });
      runtime.setLlmClient(client);
    } else if (
      current &&
      !current.publicModelId &&
      current.provider === modelOpt.provider &&
      current.model === modelOpt.model
    ) {
      runtime.setThinkingEffort(effort);
    } else if (
      current &&
      !current.publicModelId &&
      current.provider === modelOpt.provider
    ) {
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

    const publicName = modelOpt.publicModelId
      ? getPublicModel(modelOpt.publicModelId)?.name
      : undefined;
    const applied = formatModelEffortLabel(publicName ?? modelOpt.model, effort);
    return {
      ok: true,
      label: applied,
      summary: t('settings.applied', { label: applied }),
      ...(modelOpt.publicModelId
        ? { publicModelId: modelOpt.publicModelId }
        : modelOpt.profileId
          ? { profileId: modelOpt.profileId }
          : {})
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
