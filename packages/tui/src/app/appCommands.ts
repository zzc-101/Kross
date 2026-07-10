import {
  isPermissionMode,
  type AgentMode,
  type AgentRuntime,
  type ConfigImportController,
  type ConfigImportPrompt,
  type ContextInspection,
  type ExternalAgentSource,
  type PermissionMode
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
  hasPendingCrossRepoPlan: boolean,
  choosePlanApproval: (approved: boolean) => Promise<void>
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
      `当前运行在本地 TUI。mode=${mode} · perm=${runtime.getPermissionMode()}`
    );
    return true;
  }

  if (value === '/context') {
    append(
      'agent',
      formatContextInspection(
        runtime.inspectContext({
          requestedMode: mode,
          currentUserInput: ''
        })
      ),
      { expanded: true }
    );
    return true;
  }

  if (value === '/expand') {
    toggleLastCollapsible();
    append('system', '已切换最近一条 thinking 的折叠状态（也可用 ctrl+o）。');
    return true;
  }

  if (value === '/approve' || value === '/reject') {
    if (!hasPendingCrossRepoPlan) {
      append('system', '当前没有等待确认的 cross-repo 计划。');
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
    append('agent', '用法：/mode auto|normal|cross-repo');
    return true;
  }

  if (value.startsWith('/mode ')) {
    const nextMode = value.replace('/mode ', '').trim();
    if (isAgentMode(nextMode)) {
      setMode(nextMode);
      append('system', `已切换到 ${nextMode} 模式`);
    } else {
      append('agent', '未知模式，可选：auto、normal、cross-repo');
    }
    return true;
  }

  if (value === '/perm') {
    append(
      'agent',
      '用法：/perm default|classifier|auto · 也可按 shift+tab 循环切换'
    );
    return true;
  }

  if (value.startsWith('/perm ')) {
    const nextPerm = value.replace('/perm ', '').trim();
    if (isPermissionMode(nextPerm)) {
      runtime.setPermissionMode(nextPerm);
      setPermissionMode(nextPerm);
    } else {
      append('agent', '未知权限模式，可选：default、classifier、auto');
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

  append('agent', `未知命令：${value}。输入 /help 查看可用命令。`);
  return true;
}

export function formatImportPrompt(prompt: ConfigImportPrompt): string {
  const sources = prompt.candidates.map((candidate) => candidate.displayName);
  if (prompt.candidates.length === 1) {
    const candidate = prompt.candidates[0];
    return [
      `检测到 ${candidate?.displayName} 配置。`,
      `输入 /import ${candidate?.source} 一键导入，或输入 /import skip 跳过。`
    ].join('\n');
  }

  return [
    `检测到 ${sources.join(' 和 ')} 配置。`,
    '请选择一个导入：/import claude 或 /import codex；也可以输入 /import skip 跳过。'
  ].join('\n');
}

function isAgentMode(value: string): value is AgentMode {
  return value === 'auto' || value === 'normal' || value === 'cross-repo';
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
    append('system', `${command} 失败：${message}`);
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
    input.append('agent', '当前没有可导入的 Claude Code 或 Codex 配置。');
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
    input.append('agent', `已跳过配置导入。记录已保存到 ${result.configPath}`);
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
        `已导入 ${result.candidate.displayName} 配置。`,
        `配置文件: ${result.configPath}`,
        `provider: ${result.config.llm?.provider}`,
        `model: ${result.config.llm?.model}`,
        `baseUrl: ${result.config.llm?.baseUrl ?? '默认'}`,
        `credential: ${
          result.config.llm?.apiKey || result.config.llm?.authToken
            ? '已配置'
            : '未配置'
        }`
      ].join('\n'),
      { expanded: true }
    );
  } catch (error) {
    input.append(
      'agent',
      error instanceof Error ? error.message : `导入失败：${String(error)}`
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
  return `用法：${commands} | /import skip`;
}

function formatContextInspection(snapshot: ContextInspection): string {
  const sectionLines = Object.entries(snapshot.report.sections)
    .map(([section, chars]) => `- ${section}: ${chars}`)
    .join('\n');
  const contributorLines = snapshot.report.contributors
    .slice()
    .sort((left, right) => right.injectedChars - left.injectedChars)
    .slice(0, 6)
    .map(
      (contributor) =>
        `- ${contributor.title} [${contributor.section}/${contributor.status}]: ${contributor.injectedChars}/${contributor.rawChars}`
    )
    .join('\n');

  return [
    'Context',
    `mode: ${snapshot.mode}`,
    `总字符: ${snapshot.estimatedChars}`,
    `included sources: ${snapshot.includedSources.length}`,
    `dropped sources: ${snapshot.droppedSources.length}`,
    'sections:',
    sectionLines,
    'contributors:',
    contributorLines.length > 0 ? contributorLines : '- none'
  ].join('\n');
}
