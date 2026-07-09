/**
 * Soft Terminal 视觉 token。
 * Ink 只支持命名色 / hex，这里集中管理，避免组件里散落魔法字符串。
 */
export const theme = {
  brand: 'cyan',
  brandMuted: '#164e63',
  brandSoft: '#22d3ee',
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
  agentLabel: 'kross',
  userLabel: 'you',
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

/** thinking 超过该行数时默认折叠（正式回复不折叠）。 */
export const THINKING_COLLAPSE_LINE_LIMIT = 6;

/** thinking 超过该字符数时也触发折叠。 */
export const THINKING_COLLAPSE_CHAR_LIMIT = 400;

/** @deprecated 使用 THINKING_COLLAPSE_LINE_LIMIT */
export const COLLAPSED_LINE_LIMIT = THINKING_COLLAPSE_LINE_LIMIT;

/** @deprecated 使用 THINKING_COLLAPSE_CHAR_LIMIT */
export const COLLAPSED_CHAR_LIMIT = THINKING_COLLAPSE_CHAR_LIMIT;

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
  const columns = Math.max(24, Math.min(width ?? 48, 96));
  return char.repeat(columns);
}
