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

/**
 * Conductor = 高级模型编排（拆任务 → worker 执行 → 高级模型验收）。
 * 不是多目录：多目录是 /add-dir。
 */
const conductorSignals = [
  '指挥家',
  'conductor',
  '多代理',
  '子代理分工',
  '派生执行',
  '经济模型',
  '快速模型',
  '分工协作',
  '编排执行'
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

  const lower = input.input.toLowerCase();

  const conductorHits = conductorSignals.filter((signal) =>
    lower.includes(signal.toLowerCase())
  );
  if (conductorHits.length > 0) {
    return {
      mode: 'conductor',
      reason: `auto 检测到指挥家编排信号：${conductorHits.join('、')}`,
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
