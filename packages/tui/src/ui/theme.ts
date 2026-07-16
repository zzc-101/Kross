import { t } from '@kross/core';

/**
 * Soft Terminal 视觉 token。
 * Ink 只支持命名色 / hex，这里集中管理，避免组件里散落魔法字符串。
 */
export const theme = {
  brand: 'cyan',
  brandMuted: '#0e7490',
  brandSoft: '#22d3ee',
  /** 欢迎页 headline 强调色（对齐 Grok Build 的金色提示） */
  accent: 'yellow',
  /** 用户消息整行高亮。 */
  user: 'cyan',
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
  riskExecute: 'yellow',
  riskNetwork: 'yellow',
  chip: 'gray',
  tip: 'gray',
  /** 底部滚动提示高亮 */
  scrollHint: 'yellow',
  divider: 'gray',
  border: 'gray',
  prompt: 'cyan',
  selection: 'cyan',
  /** tool / thinking 行左侧方块 */
  marker: 'cyan',
  /** diff 新增行背景（深青绿） */
  diffAddBg: '#14532d',
  /** diff 删除行背景（深红） */
  diffDelBg: '#7f1d1d',
  /** diff 行上的浅色字，保证对比度 */
  diffOnBg: '#ecfdf5'
} as const;

export const symbols = {
  brandMark: 'Kross',
  /** 用户消息前缀 */
  userPrefix: '>',
  /** 助手回复小圆点 */
  agentBullet: '●',
  /** tool / thinking 行左侧小实心方块 */
  markerSquare: '▪',
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
  if (status === 'interrupting') {
    return theme.statusWarn;
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
      return t('status.ready');
    case 'responding':
      return t('status.responding');
    case 'interrupting':
      return t('status.interrupting');
    case 'waiting-approval':
      return t('status.waitingPlan');
    case 'approval-required':
      return t('status.waitingTool');
    default:
      return status;
  }
}

export function formatModeLabel(mode: string): string {
  switch (mode) {
    case 'auto':
      return t('mode.auto');
    case 'plan':
      return t('mode.plan');
    case 'conductor':
      return t('mode.conductor');
    default:
      return mode;
  }
}

/** Composer 页脚：模式：自动 / Mode: Auto */
export function formatAgentModeFooterLabel(mode: string): string {
  return t('mode.footer', { label: formatModeLabel(mode) });
}

export function formatPermissionModeLabel(mode: string): string {
  switch (mode) {
    case 'default':
      return t('perm.default');
    case 'classifier':
      return t('perm.classifier');
    case 'auto':
      return t('perm.auto');
    default:
      return t('perm.unknown', { mode });
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
