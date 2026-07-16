import type { AgentMode } from '../domain';

export interface ModeDetectionInput {
  requestedMode: AgentMode | string;
  input: string;
}

export interface ModeDetectionResult {
  mode: Exclude<AgentMode, 'auto'>;
  reason: string;
  requiresApproval: boolean;
  signals: string[];
}

/** Signals that auto-route into conductor (orchestration) mode. */
const conductorSignals = [
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
  'openapi',
  '指挥家',
  'conductor'
];

/** Accept legacy alias `cross-repo` as conductor. */
export function normalizeAgentMode(value: string): AgentMode | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'cross-repo' || trimmed === 'cross_repo') {
    return 'conductor';
  }
  if (trimmed === 'auto' || trimmed === 'normal' || trimmed === 'conductor') {
    return trimmed;
  }
  return undefined;
}

export function detectMode(input: ModeDetectionInput): ModeDetectionResult {
  const requested =
    normalizeAgentMode(String(input.requestedMode)) ?? 'auto';

  if (requested !== 'auto') {
    return {
      mode: requested,
      reason: `用户显式选择 ${requested} 模式`,
      requiresApproval: requested === 'conductor',
      signals: []
    };
  }

  const normalized = input.input.toLowerCase();
  const signals = conductorSignals.filter((signal) =>
    normalized.includes(signal.toLowerCase())
  );

  const hasConductorIntent =
    signals.includes('跨仓库') ||
    signals.includes('跨系统') ||
    signals.includes('指挥家') ||
    signals.includes('conductor') ||
    (signals.includes('前端') && signals.includes('后端')) ||
    signals.includes('前后端') ||
    (signals.includes('管理端') && signals.includes('联动'));

  if (hasConductorIntent) {
    return {
      mode: 'conductor',
      reason: `检测到需要编排的信号：${signals.join('、')}`,
      requiresApproval: true,
      signals
    };
  }

  return {
    mode: 'normal',
    reason: '未检测到编排信号，使用普通 agent 模式',
    requiresApproval: false,
    signals
  };
}
