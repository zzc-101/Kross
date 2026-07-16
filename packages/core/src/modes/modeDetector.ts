import type { AgentMode } from '../domain';

export interface ModeDetectionInput {
  requestedMode: AgentMode | string;
  input: string;
}

export interface ModeDetectionResult {
  /** Resolved mode for this turn (auto stays auto when no switch). */
  mode: AgentMode;
  reason: string;
  requiresApproval: boolean;
  signals: string[];
}

/** Signals that auto-route into conductor (multi-target orchestration). */
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

/** Signals that auto-route into plan-first mode. */
const planSignals = [
  '先规划',
  '先做计划',
  '先写方案',
  'plan first',
  'plan-first',
  'plan mode',
  '规划再',
  '方案确认',
  '先 plan',
  '先plan'
];

export function normalizeAgentMode(value: string): AgentMode | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'auto' || trimmed === 'plan' || trimmed === 'conductor') {
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
      requiresApproval: requested === 'plan' || requested === 'conductor',
      signals: []
    };
  }

  const text = input.input;
  const lower = text.toLowerCase();

  const conductorHits = conductorSignals.filter((signal) =>
    lower.includes(signal.toLowerCase())
  );
  const hasConductorIntent =
    conductorHits.includes('跨仓库') ||
    conductorHits.includes('跨系统') ||
    conductorHits.includes('指挥家') ||
    conductorHits.includes('conductor') ||
    (conductorHits.includes('前端') && conductorHits.includes('后端')) ||
    conductorHits.includes('前后端') ||
    (conductorHits.includes('管理端') && conductorHits.includes('联动'));

  if (hasConductorIntent) {
    return {
      mode: 'conductor',
      reason: `auto 检测到编排信号：${conductorHits.join('、')}`,
      requiresApproval: true,
      signals: conductorHits
    };
  }

  const planHits = planSignals.filter((signal) =>
    lower.includes(signal.toLowerCase())
  );
  if (planHits.length > 0) {
    return {
      mode: 'plan',
      reason: `auto 检测到计划优先信号：${planHits.join('、')}`,
      requiresApproval: true,
      signals: planHits
    };
  }

  return {
    mode: 'auto',
    reason: 'auto 默认 agent 工具环（未切换到 plan/conductor）',
    requiresApproval: false,
    signals: []
  };
}
