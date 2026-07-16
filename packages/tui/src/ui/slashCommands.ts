import { t } from '@kross/core';

export type SlashCommandCategory =
  | 'common'
  | 'inspection'
  | 'settings'
  | 'contextual';

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  category: SlashCommandCategory;
  suggestion?: boolean;
  requiresPendingConductorPlan?: boolean;
}

/** Live slash command list (descriptions follow current locale). */
export function listSlashCommands(): SlashCommand[] {
  return [
    {
      name: '/help',
      description: t('slash.help.desc'),
      category: 'common'
    },
    {
      name: '/settings',
      description: t('slash.settings.desc'),
      usage: '/settings',
      category: 'common'
    },
    {
      name: '/model',
      description: t('slash.model.desc'),
      usage: '/model [model|effort]',
      category: 'common'
    },
    {
      name: '/mode',
      description: t('slash.mode.desc'),
      usage: '/mode auto|plan|conductor',
      category: 'common'
    },
    {
      name: '/add-dir',
      description: t('slash.addDir.desc'),
      usage: '/add-dir <path>',
      category: 'common'
    },
    {
      name: '/dirs',
      description: t('slash.dirs.desc'),
      usage: '/dirs',
      category: 'common'
    },
    {
      name: '/remove-dir',
      description: t('slash.removeDir.desc'),
      usage: '/remove-dir <id|path>',
      category: 'common'
    },
    {
      name: '/resume',
      description: t('slash.resume.desc'),
      usage: '/resume [sessionId]',
      category: 'common'
    },
    {
      name: '/lang',
      description: t('slash.lang.desc'),
      usage: '/lang zh|en',
      category: 'settings'
    },
    {
      name: '/status',
      description: t('slash.status.desc'),
      category: 'inspection'
    },
    {
      name: '/context',
      description: t('slash.context.desc'),
      category: 'inspection'
    },
    {
      name: '/instructions',
      description: t('slash.instructions.desc'),
      category: 'inspection'
    },
    {
      name: '/skills',
      description: t('slash.skills.desc'),
      category: 'inspection'
    },
    {
      name: '/compact',
      description: t('slash.compact.desc'),
      usage: '/compact [额外压缩要求]',
      category: 'inspection'
    },
    {
      name: '/trace',
      description: t('slash.trace.desc'),
      usage: '/trace [runId]',
      category: 'inspection'
    },
    {
      name: '/diff',
      description: t('slash.diff.desc'),
      usage: '/diff [runId]',
      category: 'inspection'
    },
    {
      name: '/perm',
      description: t('slash.perm.desc'),
      usage: '/perm default|classifier|auto',
      category: 'settings'
    },
    {
      name: '/import',
      description: t('slash.import.desc'),
      usage: '/import claude|codex|skip',
      category: 'settings'
    },
    {
      name: '/approve',
      description: t('slash.approve.desc'),
      category: 'contextual',
      requiresPendingConductorPlan: true
    },
    {
      name: '/reject',
      description: t('slash.reject.desc'),
      category: 'contextual',
      requiresPendingConductorPlan: true
    },
    {
      name: '/expand',
      description: t('slash.expand.desc'),
      category: 'settings',
      suggestion: false
    }
  ];
}

/** @deprecated Prefer listSlashCommands() so descriptions track locale. */
export const slashCommands: SlashCommand[] = listSlashCommands();

export interface SlashSuggestionOptions {
  hasPendingConductorPlan?: boolean;
  limit?: number;
}

export interface SlashSuggestionResult {
  commands: SlashCommand[];
  hiddenCount: number;
}

export function getSlashCommandSuggestions(
  query: string,
  options: SlashSuggestionOptions = {}
): SlashSuggestionResult {
  const normalized = query.trim().toLowerCase();
  if (!normalized.startsWith('/')) {
    return { commands: [], hiddenCount: 0 };
  }

  const contextual: SlashCommand[] = [];
  const regular: SlashCommand[] = [];

  for (const command of listSlashCommands()) {
    if (command.suggestion === false) {
      continue;
    }
    if (
      command.requiresPendingConductorPlan &&
      !options.hasPendingConductorPlan
    ) {
      continue;
    }
    const matches =
      normalized === '/' ||
      command.name.startsWith(normalized) ||
      command.name.slice(1).startsWith(normalized.slice(1));
    if (!matches) {
      continue;
    }
    if (command.category === 'contextual') {
      contextual.push(command);
    } else {
      regular.push(command);
    }
  }

  const matches = [...contextual, ...regular];
  const limit = Math.max(1, options.limit ?? 8);
  return {
    commands: matches.slice(0, limit),
    hiddenCount: Math.max(0, matches.length - limit)
  };
}

export function filterSlashCommands(
  query: string,
  options: SlashSuggestionOptions = {}
): SlashCommand[] {
  return getSlashCommandSuggestions(query, options).commands;
}

export function formatSlashHelp(): string {
  return [
    t('slash.help.header'),
    ...listSlashCommands().map((command) => {
      const usage = command.usage ?? command.name;
      return `- ${usage}  ${command.description}`;
    })
  ].join('\n');
}
