import type { AgentMode } from '../domain';

export interface ModeDetectionInput {
  requestedMode: AgentMode;
  input: string;
}

export interface ModeDetectionResult {
  mode: Exclude<AgentMode, 'auto'>;
  reason: string;
  requiresApproval: boolean;
  signals: string[];
}

const crossRepoSignals = [
  '前后端',
  '前端',
  '后端',
  '管理端',
  '跨仓库',
  '跨系统',
  '联动',
  '接口字段',
  '字段贯通',
  'api client',
  'openapi'
];

export function detectMode(input: ModeDetectionInput): ModeDetectionResult {
  if (input.requestedMode !== 'auto') {
    return {
      mode: input.requestedMode,
      reason: `用户显式选择 ${input.requestedMode} 模式`,
      requiresApproval: input.requestedMode === 'cross-repo',
      signals: []
    };
  }

  const normalized = input.input.toLowerCase();
  const signals = crossRepoSignals.filter((signal) =>
    normalized.includes(signal.toLowerCase())
  );

  const hasCrossRepoIntent =
    signals.includes('跨仓库') ||
    signals.includes('跨系统') ||
    (signals.includes('前端') && signals.includes('后端')) ||
    signals.includes('前后端') ||
    (signals.includes('管理端') && signals.includes('联动'));

  if (hasCrossRepoIntent) {
    return {
      mode: 'cross-repo',
      reason: `检测到跨系统信号：${signals.join('、')}`,
      requiresApproval: true,
      signals
    };
  }

  return {
    mode: 'normal',
    reason: '未检测到跨仓库信号，使用普通 agent 模式',
    requiresApproval: false,
    signals
  };
}
