/**
 * Soft Terminal 视觉 token。
 * Ink 只支持命名色 / hex，这里集中管理，避免组件里散落魔法字符串。
 */
export const theme = {
  brand: 'cyan',
  brandMuted: '#164e63',
  user: 'gray',
  agent: 'cyan',
  statusReady: 'green',
  statusBusy: 'yellow',
  statusWarn: 'yellow',
  statusError: 'red',
  approve: 'green',
  reject: 'red',
  dim: undefined as undefined,
  tip: 'gray',
  divider: 'gray',
  prompt: 'cyan'
} as const;

export const symbols = {
  brandMark: 'Kross',
  agentLabel: 'kross',
  userLabel: 'you',
  prompt: '❯',
  readyDot: '●',
  busyFrames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const,
  pulseDots: ['●', '○', '●', '○'] as const,
  cursorFrames: ['█', ' '] as const,
  approvePointer: '❯',
  messageRail: '│'
} as const;

export type UiStatus =
  | 'ready'
  | 'responding'
  | 'waiting-approval'
  | 'approval-required'
  | string;

export function statusTone(status: UiStatus): typeof theme.statusReady | typeof theme.statusBusy | typeof theme.statusWarn | typeof theme.statusError {
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
