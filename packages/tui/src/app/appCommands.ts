import {
  formatCompactCount,
  getLocale,
  getLlmProviderDefinition,
  handleModelCommand,
  isAppLocale,
  isPermissionMode,
  loadKrossConfig,
  setLocale,
  t,
  updateKrossLocale,
  updateKrossLlmConfig,
  normalizeAgentMode,
  type AgentMode,
  type AgentRuntime,
  type ConfigImportController,
  type ConfigImportPrompt,
  type ContextInspection,
  type ContextMaintenanceResult,
  type ContextSection,
  type ExternalAgentSource,
  type PermissionMode,
  type ThinkingEffort
} from '@kross/core';

import { formatSlashHelp, type ChatMessage } from '../ui';

type AppendMessage = (
  from: ChatMessage['from'],
  text: string,
  options?: { expanded?: boolean }
) => void;

export function handleCommand(
  value: string,
  append: AppendMessage,
  setMode: (mode: AgentMode) => void,
  setPermissionMode: (mode: PermissionMode) => void,
  runtime: AgentRuntime,
  mode: AgentMode,
  importPrompt: ConfigImportPrompt | undefined,
  configImportController: ConfigImportController | undefined,
  setImportPrompt: (prompt: ConfigImportPrompt | undefined) => void,
  refreshRuntime: () => void,
  toggleLastCollapsible: () => void,
  hasPendingConductorPlan: boolean,
  choosePlanApproval: (approved: boolean) => Promise<void>,
  onLocaleChange?: () => void
): boolean {
  if (!value.startsWith('/')) {
    return false;
  }

  if (value === '/help') {
    append('agent', formatSlashHelp(), { expanded: true });
    return true;
  }

  if (value === '/status') {
    append(
      'agent',
      t('cmd.status', {
        mode,
        perm: runtime.getPermissionMode(),
        model: runtime.getModelLabel()
      })
    );
    return true;
  }

  if (value === '/lang' || value.startsWith('/lang ')) {
    const argument =
      value === '/lang' ? '' : value.slice('/lang'.length).trim().toLowerCase();
    if (!argument) {
      append(
        'agent',
        `${t('cmd.lang.current', { locale: getLocale() })}\n${t('cmd.lang.usage')}`,
        { expanded: true }
      );
      return true;
    }
    if (!isAppLocale(argument)) {
      append('agent', t('cmd.lang.unknown'));
      return true;
    }
    setLocale(argument);
    try {
      updateKrossLocale(argument);
    } catch {
      // best-effort persistence
    }
    onLocaleChange?.();
    append('system', t('cmd.lang.switched', { locale: argument }));
    return true;
  }

  if (value === '/model' || value.startsWith('/model ')) {
    const argument =
      value === '/model' ? undefined : value.slice('/model'.length).trim();
    const saved = loadKrossConfig()?.llm;
    const result = handleModelCommand(
      argument,
      runtime.getLlmClient(),
      process.env,
      saved
    );

    if (result.kind === 'set-model') {
      persistModelPreference(
        result.provider,
        result.model,
        runtime.getThinkingEffort()
      );
    }

    if (result.kind === 'set-effort') {
      persistModelPreference(result.provider, result.model, result.effort);
    }

    if (result.kind === 'replace-client') {
      const effort = runtime.getThinkingEffort();
      if (result.client.setThinkingEffort) {
        result.client.setThinkingEffort(effort);
      }
      runtime.setLlmClient(result.client);
      persistModelPreference(result.provider, result.model, effort);
    }

    append('agent', result.text, { expanded: true });
    return true;
  }

  if (value === '/context') {
    const snapshot = runtime.inspectContext({
      requestedMode: mode,
      currentUserInput: ''
    });
    const usage = runtime.getContextUsage({
      requestedMode: mode,
      currentUserInput: ''
    });
    append(
      'agent',
      formatContextInspection(snapshot, runtime.getAllContextMaintenance(), {
        lastUsageTokens: usage.lastUsageTokens
      }),
      { expanded: true }
    );
    return true;
  }

  if (value === '/expand') {
    toggleLastCollapsible();
    append('system', t('cmd.expandDone'));
    return true;
  }

  if (value === '/approve' || value === '/reject') {
    if (!hasPendingConductorPlan) {
      append('system', t('app.noConductorPlan'));
      return true;
    }
    void choosePlanApproval(value === '/approve');
    return true;
  }

  if (value === '/import' || value.startsWith('/import ')) {
    handleImportCommand({
      value,
      append,
      importPrompt,
      configImportController,
      setImportPrompt,
      refreshRuntime
    });
    return true;
  }

  if (value === '/mode') {
    append('agent', t('cmd.modeUsage'));
    return true;
  }

  if (value.startsWith('/mode ')) {
    const nextMode = value.replace('/mode ', '').trim();
    const normalized = normalizeAgentMode(nextMode);
    if (normalized) {
      setMode(normalized);
      append(
        'system',
        t('cmd.modeSwitched', {
          mode: normalized === 'conductor' ? t('mode.conductor') : normalized
        })
      );
    } else {
      append('agent', t('cmd.modeUnknown'));
    }
    return true;
  }

  if (value === '/add-dir' || value.startsWith('/add-dir ')) {
    const argument =
      value === '/add-dir' ? '' : value.slice('/add-dir'.length).trim();
    if (!argument) {
      append('agent', t('cmd.addDir.usage'));
      return true;
    }
    const roots = runtime.getWorkspaceRoots();
    if (!roots) {
      append('system', t('cmd.addDir.unavailable'));
      return true;
    }
    try {
      const added = roots.add(argument);
      runtime.syncProjectRegistrySource();
      append(
        'system',
        t('cmd.addDir.ok', { id: added.id, path: added.path })
      );
    } catch (error) {
      append(
        'system',
        t('cmd.addDir.fail', {
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
    return true;
  }

  if (value === '/dirs') {
    const roots = runtime.getWorkspaceRoots();
    if (!roots) {
      append('system', t('cmd.addDir.unavailable'));
      return true;
    }
    const list = roots.list();
    const lines = list.map(
      (entry) =>
        `- id=${entry.id}${entry.primary ? ' (primary)' : ''} path=${entry.path}`
    );
    append('agent', [t('cmd.dirs.header'), ...lines].join('\n'), {
      expanded: true
    });
    return true;
  }

  if (value === '/remove-dir' || value.startsWith('/remove-dir ')) {
    const argument =
      value === '/remove-dir' ? '' : value.slice('/remove-dir'.length).trim();
    if (!argument) {
      append('agent', t('cmd.removeDir.usage'));
      return true;
    }
    const roots = runtime.getWorkspaceRoots();
    if (!roots) {
      append('system', t('cmd.addDir.unavailable'));
      return true;
    }
    try {
      const removed = roots.remove(argument);
      if (!removed) {
        append('system', t('cmd.removeDir.missing', { target: argument }));
      } else {
        runtime.syncProjectRegistrySource();
        append('system', t('cmd.removeDir.ok', { target: argument }));
      }
    } catch (error) {
      append(
        'system',
        t('cmd.removeDir.fail', {
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
    return true;
  }

  if (value === '/perm') {
    append('agent', t('cmd.permUsage'));
    return true;
  }

  if (value.startsWith('/perm ')) {
    const nextPerm = value.replace('/perm ', '').trim();
    if (isPermissionMode(nextPerm)) {
      runtime.setPermissionMode(nextPerm);
      setPermissionMode(nextPerm);
    } else {
      append('agent', t('cmd.permUnknown'));
    }
    return true;
  }

  if (value === '/trace' || value.startsWith('/trace ')) {
    const argument =
      value === '/trace' ? undefined : value.slice('/trace'.length).trim();
    void runSlashAsync(
      () => runtime.formatTraceCommand(argument),
      append,
      '/trace'
    );
    return true;
  }

  if (value === '/diff' || value.startsWith('/diff ')) {
    const argument =
      value === '/diff' ? undefined : value.slice('/diff'.length).trim();
    void runSlashAsync(
      () => runtime.formatDiffCommand(argument),
      append,
      '/diff'
    );
    return true;
  }

  append('agent', t('cmd.unknown', { value }));
  return true;
}

/** `/compact` 会改写 Thread，必须由提交层串行执行，不能走普通异步命令。 */
export async function executeCompactCommand(
  value: string,
  runtime: AgentRuntime,
  mode: AgentMode,
  signal?: AbortSignal
): Promise<string> {
  const instructions = value.slice('/compact'.length).trim() || undefined;
  return formatCompactResult(
    await runtime.compactNow(
      {
        requestedMode: mode,
        currentUserInput: ''
      },
      instructions,
      signal
    ),
    runtime.getPreserveFullTurns()
  );
}

export function formatImportPrompt(prompt: ConfigImportPrompt): string {
  const sources = prompt.candidates.map((candidate) => candidate.displayName);
  if (prompt.candidates.length === 1) {
    const candidate = prompt.candidates[0];
    return [
      t('cmd.import.detectOne', { name: candidate?.displayName ?? '' }),
      t('cmd.import.importOne', { source: candidate?.source ?? '' })
    ].join('\n');
  }

  return [
    t('cmd.import.detectMany', {
      names: sources.join(t('cmd.lang.and'))
    }),
    t('cmd.import.choose')
  ].join('\n');
}



async function runSlashAsync(
  run: () => Promise<string>,
  append: AppendMessage,
  command: string
): Promise<void> {
  try {
    const text = await run();
    append('agent', text, { expanded: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append('system', t('cmd.asyncFailed', { command, message }));
  }
}

function handleImportCommand(input: {
  value: string;
  append: AppendMessage;
  importPrompt: ConfigImportPrompt | undefined;
  configImportController: ConfigImportController | undefined;
  setImportPrompt: (prompt: ConfigImportPrompt | undefined) => void;
  refreshRuntime: () => void;
}): void {
  if (!input.configImportController) {
    input.append('agent', t('cmd.import.none'));
    return;
  }

  const target = input.value.replace('/import', '').trim();
  if (target.length === 0) {
    input.append('agent', formatImportUsage(input.importPrompt));
    return;
  }
  if (target === 'skip') {
    const result = input.configImportController.skip();
    input.setImportPrompt(undefined);
    input.append(
      'agent',
      t('cmd.import.skipped', { path: result.configPath })
    );
    return;
  }
  if (!isExternalAgentSource(target)) {
    input.append('agent', formatImportUsage(input.importPrompt));
    return;
  }

  try {
    const result = input.configImportController.importSource(target);
    input.setImportPrompt(undefined);
    input.refreshRuntime();
    input.append(
      'agent',
      [
        t('cmd.import.done', { name: result.candidate.displayName }),
        t('cmd.import.configPath', { path: result.configPath }),
        `provider: ${result.config.llm?.provider}`,
        `model: ${result.config.llm?.model}`,
        `baseUrl: ${result.config.llm?.baseUrl ?? t('cmd.import.defaultBase')}`,
        `credential: ${
          result.config.llm?.apiKey || result.config.llm?.authToken
            ? t('cmd.import.credentialYes')
            : t('cmd.import.credentialNo')
        }`
      ].join('\n'),
      { expanded: true }
    );
  } catch (error) {
    input.append(
      'agent',
      error instanceof Error
        ? error.message
        : t('cmd.import.failed', { error: String(error) })
    );
  }
}

function isExternalAgentSource(value: string): value is ExternalAgentSource {
  return value === 'claude' || value === 'codex';
}

function formatImportUsage(prompt: ConfigImportPrompt | undefined): string {
  const commands = prompt?.candidates.length
    ? prompt.candidates
        .map((candidate) => `/import ${candidate.source}`)
        .join(' | ')
    : '/import claude | /import codex';
  return t('cmd.import.usage', { commands });
}

function persistModelPreference(
  provider: import('@kross/core').LlmProvider,
  model: string,
  thinkingEffort?: ThinkingEffort
): void {
  try {
    const def = getLlmProviderDefinition(provider);
    const env = process.env;
    // Only pass secrets when present in env — never send undefined and rely
    // on merge to keep import-saved keys (updateKrossLlmConfig also refuses
    // to write unusable configs).
    const apiKey = def.apiKeyEnv.map((key) => env[key]?.trim()).find(Boolean);
    const authToken = def.authTokenEnv
      ?.map((key) => env[key]?.trim())
      .find(Boolean);
    const baseUrl = def.baseUrlEnv ? env[def.baseUrlEnv]?.trim() : undefined;

    updateKrossLlmConfig({
      provider,
      model,
      ...(apiKey ? { apiKey } : {}),
      ...(provider === 'anthropic' && authToken ? { authToken } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(provider === 'anthropic' && env.ANTHROPIC_VERSION
        ? { anthropicVersion: env.ANTHROPIC_VERSION }
        : {}),
      ...(thinkingEffort ? { thinkingEffort } : {})
    });
  } catch {
    // best-effort: refuse-to-wipe errors are swallowed so the session still works
  }
}

function formatContextInspection(
  snapshot: ContextInspection,
  maintenance: ContextMaintenanceResult[],
  options: { lastUsageTokens?: number } = {}
): string {
  const sectionOrder: ContextSection[] = [
    'system',
    'thread',
    'sources',
    'skills',
    'tools'
  ];
  const sectionLines = sectionOrder.map((section) => {
    const tokens = snapshot.report.sections[section] ?? 0;
    return `  ${section.padEnd(8)} ${formatCompactCount(tokens)}`;
  });

  const included =
    snapshot.includedSources.length > 0
      ? snapshot.includedSources.join(', ')
      : '(none)';
  const dropped =
    snapshot.droppedSources.length > 0
      ? snapshot.droppedSources.join(', ')
      : '(none)';
  const pinned =
    snapshot.pinnedSources.length > 0
      ? snapshot.pinnedSources.join(', ')
      : '(none)';

  const maintenanceLines = maintenance
    .slice(-5)
    .reverse()
    .map((item) => {
      const stage = formatMaintenanceStage(item);
      const time = item.at ? formatMaintenanceTime(item.at) : '-';
      return `  ${stage.padEnd(16)} ${formatCompactCount(item.tokensBefore)} -> ${formatCompactCount(item.tokensAfter)}  ${time}`;
    });

  const lines = [
    t('cmd.context.title'),
    `mode: ${snapshot.mode}`,
    `${t('cmd.context.estimated')}: ${formatCompactCount(snapshot.estimatedTokens)} / ${formatCompactCount(snapshot.inputBudget)} (${t('cmd.context.budget')})`,
    `${t('cmd.context.threshold')}: ${formatCompactCount(snapshot.compactThreshold)}`,
    options.lastUsageTokens !== undefined
      ? `${t('cmd.context.lastUsage')}: ${formatCompactCount(options.lastUsageTokens)}`
      : undefined,
    '',
    t('cmd.context.sections'),
    ...sectionLines,
    '',
    t('cmd.context.sources'),
    `  included: ${included}`,
    `  dropped:  ${dropped}`,
    `  pinned:   ${pinned}`,
    '',
    t('cmd.context.maintenance'),
    maintenanceLines.length > 0
      ? maintenanceLines.join('\n')
      : `  ${t('cmd.context.noMaintenance')}`
  ];

  return lines.filter((line): line is string => line !== undefined).join('\n');
}

export function formatCompactResult(
  result: ContextMaintenanceResult,
  preserveFullTurns = 4
): string {
  if (!result.compacted) {
    return t('cmd.compact.nothing', { preserve: preserveFullTurns });
  }
  return t('cmd.compact.done', {
    turns: result.droppedTurnCount ?? 0,
    before: formatCompactCount(result.tokensBefore),
    after: formatCompactCount(result.tokensAfter)
  });
}

function formatMaintenanceStage(item: ContextMaintenanceResult): string {
  if (item.stage === 'tool-aging') {
    return 'Stage1';
  }
  if (item.stage === 'turn-compaction') {
    return 'Stage2';
  }
  if (item.stage === 'hard-truncation') {
    return 'Stage3';
  }
  return item.reason ?? '-';
}

function formatMaintenanceTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export { formatContextInspection };
