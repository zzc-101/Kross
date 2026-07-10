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
    name: '/settings',
    description: '打开模型/思考强度面板（等同 ctrl+p）',
    usage: '/settings'
  },
  {
    name: '/model',
    description: '面板 / 切模型 / 切思考强度',
    usage: '/model [list|<model>|<provider> <model>|<effort>|cycle]'
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
    description: '查看最近运行与工具/审批/失败摘要',
    usage: '/trace [runId]'
  },
  {
    name: '/diff',
    description: '查看 agent 触达文件与工作区 git 变更',
    usage: '/diff [runId]'
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
