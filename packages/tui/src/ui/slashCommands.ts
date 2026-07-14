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
  requiresPendingCrossRepoPlan?: boolean;
}

export const slashCommands: SlashCommand[] = [
  {
    name: '/help',
    description: '查看全部命令',
    category: 'common'
  },
  {
    name: '/settings',
    description: '模型与思考强度',
    usage: '/settings',
    category: 'common'
  },
  {
    name: '/model',
    description: '切换模型或思考强度',
    usage: '/model [model|effort]',
    category: 'common'
  },
  {
    name: '/mode',
    description: '切换 Agent 模式',
    usage: '/mode auto|normal|cross-repo',
    category: 'common'
  },
  {
    name: '/status',
    description: '查看当前运行状态',
    category: 'inspection'
  },
  {
    name: '/context',
    description: '查看会话上下文占用',
    category: 'inspection'
  },
  {
    name: '/trace',
    description: '查看最近运行记录',
    usage: '/trace [runId]',
    category: 'inspection'
  },
  {
    name: '/diff',
    description: '查看文件与 Git 变更',
    usage: '/diff [runId]',
    category: 'inspection'
  },
  {
    name: '/perm',
    description: '切换工具权限模式',
    usage: '/perm default|classifier|auto',
    category: 'settings'
  },
  {
    name: '/import',
    description: '导入 Claude Code / Codex 配置',
    usage: '/import claude|codex|skip',
    category: 'settings'
  },
  {
    name: '/approve',
    description: '确认等待中的跨仓库计划',
    category: 'contextual',
    requiresPendingCrossRepoPlan: true
  },
  {
    name: '/reject',
    description: '取消等待中的跨仓库计划',
    category: 'contextual',
    requiresPendingCrossRepoPlan: true
  },
  {
    name: '/expand',
    description: '切换最近一条思考过程折叠（等同 ctrl+o）',
    category: 'settings',
    suggestion: false
  }
];

export interface SlashSuggestionOptions {
  hasPendingCrossRepoPlan?: boolean;
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

  for (const command of slashCommands) {
    if (command.suggestion === false) {
      continue;
    }
    if (
      command.requiresPendingCrossRepoPlan &&
      !options.hasPendingCrossRepoPlan
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
    '可用命令：',
    ...slashCommands.map((command) => {
      const usage = command.usage ?? command.name;
      return `- ${usage}  ${command.description}`;
    })
  ].join('\n');
}
