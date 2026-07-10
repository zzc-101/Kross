/**
 * Soft Terminal 视觉 token。
 * Ink 只支持命名色 / hex，这里集中管理，避免组件里散落魔法字符串。
 */
export const theme = {
  brand: 'cyan',
  brandMuted: '#164e63',
  brandSoft: '#22d3ee',
  /** 欢迎页 headline 强调色（对齐 Grok Build 的金色提示） */
  accent: 'yellow',
  user: 'gray',
  agent: 'cyan',
  system: 'gray',
  statusReady: 'green',
  statusBusy: 'yellow',
  statusWarn: 'yellow',
  statusError: 'red',
  approve: 'green',
  reject: 'red',
  riskRead: 'green',
  riskWrite: 'yellow',
  riskExecute: 'red',
  riskNetwork: 'magenta',
  chip: 'gray',
  tip: 'gray',
  divider: 'gray',
  border: 'gray',
  prompt: 'cyan',
  selection: 'cyan'
} as const;

export const symbols = {
  brandMark: 'Kross',
  /** Claude Code 风格：用户消息前缀 */
  userPrefix: '>',
  /** Claude Code 风格：助手回复小圆点 */
  agentBullet: '●',
  systemPrefix: '·',
  prompt: '❯',
  readyDot: '●',
  busyFrames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const,
  pulseDots: ['●', '○', '●', '○'] as const,
  cursorFrames: ['█', ' '] as const,
  approvePointer: '▸',
  approvePointerSoft: '▹',
  messageRail: '│',
  boxTopLeft: '╭',
  boxTopRight: '╮',
  boxBottomLeft: '╰',
  boxBottomRight: '╯',
  boxHorizontal: '─',
  boxVertical: '│',
  suggestPointer: '❯',
  dividerChar: '─',
  softDividerChar: '·',
  toolOk: '✓',
  toolFail: '✗',
  toolWait: '…',
  collapseMark: '…'
} as const;

export type UiStatus =
  | 'ready'
  | 'responding'
  | 'waiting-approval'
  | 'approval-required'
  | string;

export function statusTone(
  status: UiStatus
):
  | typeof theme.statusReady
  | typeof theme.statusBusy
  | typeof theme.statusWarn
  | typeof theme.statusError {
  if (status === 'ready') {
    return theme.statusReady;
  }
  if (status === 'responding') {
    return theme.statusBusy;
  }
  if (status === 'waiting-approval' || status === 'approval-required') {
    return theme.statusWarn;
  }
  if (status === 'failed' || status.includes('error')) {
    return theme.statusError;
  }
  return theme.statusBusy;
}

export function formatStatusLabel(status: UiStatus): string {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'responding':
      return 'thinking';
    case 'waiting-approval':
      return 'awaiting plan';
    case 'approval-required':
      return 'awaiting tool';
    default:
      return status;
  }
}

export function riskTone(risk: string): string {
  switch (risk) {
    case 'read':
      return theme.riskRead;
    case 'write':
      return theme.riskWrite;
    case 'execute':
      return theme.riskExecute;
    case 'network':
      return theme.riskNetwork;
    default:
      return theme.statusWarn;
  }
}

/** 按终端宽度生成分隔线，宽度不可用时回退固定长度。 */
export function makeDivider(width?: number, char: string = symbols.dividerChar): string {
  const columns = Math.max(24, width ?? 48);
  return char.repeat(columns);
}
