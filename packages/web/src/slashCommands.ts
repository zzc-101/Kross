export type WebSlashCommandId =
  | 'help'
  | 'new'
  | 'mode'
  | 'model'
  | 'think'
  | 'perm'
  | 'context'
  | 'compact'
  | 'status'
  | 'instructions'
  | 'skills'
  | 'processes'
  | 'undo'
  | 'diff'
  | 'trace';

export interface WebSlashCommand {
  id: WebSlashCommandId;
  name: `/${WebSlashCommandId}`;
  usage: string;
  acceptsArgument: boolean;
}

export const WEB_SLASH_COMMANDS: WebSlashCommand[] = [
  { id: 'help', name: '/help', usage: '/help', acceptsArgument: false },
  { id: 'new', name: '/new', usage: '/new', acceptsArgument: false },
  {
    id: 'mode',
    name: '/mode',
    usage: '/mode auto|plan|conductor',
    acceptsArgument: true
  },
  {
    id: 'model',
    name: '/model',
    usage: '/model [modelId]',
    acceptsArgument: true
  },
  {
    id: 'think',
    name: '/think',
    usage: '/think off|minimal|low|medium|high|xhigh',
    acceptsArgument: true
  },
  {
    id: 'perm',
    name: '/perm',
    usage: '/perm default|classifier|auto',
    acceptsArgument: true
  },
  {
    id: 'context',
    name: '/context',
    usage: '/context',
    acceptsArgument: false
  },
  {
    id: 'compact',
    name: '/compact',
    usage: '/compact [instructions]',
    acceptsArgument: true
  },
  { id: 'status', name: '/status', usage: '/status', acceptsArgument: false },
  {
    id: 'instructions',
    name: '/instructions',
    usage: '/instructions',
    acceptsArgument: false
  },
  { id: 'skills', name: '/skills', usage: '/skills', acceptsArgument: false },
  {
    id: 'processes',
    name: '/processes',
    usage: '/processes',
    acceptsArgument: false
  },
  {
    id: 'undo',
    name: '/undo',
    usage: '/undo [runId|transactionId]',
    acceptsArgument: true
  },
  { id: 'diff', name: '/diff', usage: '/diff', acceptsArgument: false },
  { id: 'trace', name: '/trace', usage: '/trace', acceptsArgument: false }
];

export function filterWebSlashCommands(query: string): WebSlashCommand[] {
  const normalized = query.trimStart().toLowerCase();
  if (!normalized.startsWith('/') || normalized.includes(' ')) return [];
  const exact = WEB_SLASH_COMMANDS.find((command) => command.name === normalized);
  if (exact && !exact.acceptsArgument) return [];
  return WEB_SLASH_COMMANDS.filter((command) =>
    command.name.startsWith(normalized)
  );
}

export function parseWebSlashCommand(
  value: string
): { command?: WebSlashCommand; argument: string } {
  const [name = '', ...rest] = value.trim().split(/\s+/);
  return {
    command: WEB_SLASH_COMMANDS.find((candidate) => candidate.name === name),
    argument: rest.join(' ')
  };
}
