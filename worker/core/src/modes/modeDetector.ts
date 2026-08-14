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

/** 明显是「干活」而不是纯切模式时的关键词。 */
const workBeyondSwitchSignals = [
  '拆任务',
  '实现',
  '修复',
  '开发',
  '重构',
  '执行',
  '验收',
  '改代码',
  '修 bug',
  '修bug',
  '编写',
  '排查',
  '优化',
  '迁移'
];

export function normalizeAgentMode(value: string): AgentMode | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'auto' || trimmed === 'plan' || trimmed === 'conductor') {
    return trimmed;
  }
  return undefined;
}

/**
 * 识别纯会话 Mode 切换话术，让 agent-loop 调用 SetMode。
 * 带具体工作内容的请求仍按正常 auto detection 路由。
 */
export function isModeSwitchRequest(input: string): boolean {
  const text = input.trim();
  if (!text || text.length > 72) {
    return false;
  }
  if (/[：:].{6,}/.test(text)) {
    return false;
  }
  const lower = text.toLowerCase();
  if (workBeyondSwitchSignals.some((signal) => lower.includes(signal))) {
    return false;
  }

  return (
    /(切换|切到|切成|改成|改到|设为|设置为|进入|打开|启用|回到|返回).{0,16}(模式|mode|指挥家|conductor|plan|规划|auto|自动)/i.test(
      text
    ) ||
    /(帮我|请|要|想).{0,8}(切换|切到).{0,12}(模式|指挥家|conductor|plan)/i.test(
      text
    ) ||
    /^(用|使用)\s*(指挥家|conductor|plan|规划)\s*模式\s*[!！.。]?$/i.test(
      text
    ) ||
    /switch\s+to\s+(conductor|plan|auto)\b/i.test(text) ||
    /\bset\s*mode\b/i.test(text)
  );
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

  if (isModeSwitchRequest(input.input)) {
    return {
      mode: 'auto',
      reason: 'auto 识别为切换 Mode 请求（走 agent-loop + SetMode）',
      requiresApproval: false,
      signals: ['mode-switch']
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
