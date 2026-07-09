export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
}

export const slashCommands: SlashCommand[] = [
  {
    name: '/help',
    description: '查看可用命令'
  },
  {
    name: '/status',
    description: '查看当前运行状态'
  },
  {
    name: '/context',
    description: '查看当前会话上下文占用'
  },
  {
    name: '/mode',
    description: '切换 agent 模式',
    usage: '/mode auto|normal|cross-repo'
  },
  {
    name: '/import',
    description: '导入 Claude Code / Codex 配置',
    usage: '/import claude|codex|skip'
  },
  {
    name: '/trace',
    description: '查看最近 trace（后续版本）'
  },
  {
    name: '/diff',
    description: '查看变更摘要（后续版本）'
  },
  {
    name: '/perm',
    description: '切换工具权限模式',
    usage: '/perm default|classifier|auto'
  },
  {
    name: '/approve',
    description: '确认等待中的 cross-repo 计划'
  },
  {
    name: '/reject',
    description: '取消等待中的 cross-repo 计划'
  },
  {
    name: '/expand',
    description: '切换最近一条 thinking 折叠（等同 ctrl+o）'
  }
];

export function filterSlashCommands(query: string): SlashCommand[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized.startsWith('/')) {
    return [];
  }

  return slashCommands.filter((command) => {
    if (normalized === '/') {
      return true;
    }
    return (
      command.name.startsWith(normalized) ||
      command.name.slice(1).startsWith(normalized.slice(1))
    );
  });
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
