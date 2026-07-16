import { describe, expect, it } from 'vitest';

import { detectMode, normalizeAgentMode } from './modeDetector';

describe('detectMode', () => {
  it('keeps explicit auto mode as agent default', () => {
    const result = detectMode({
      requestedMode: 'auto',
      input: '帮我给当前模块补一个单元测试'
    });

    expect(result.mode).toBe('auto');
    expect(result.requiresApproval).toBe(false);
  });

  it('keeps explicit plan and conductor modes', () => {
    expect(detectMode({ requestedMode: 'plan', input: '随便' }).mode).toBe(
      'plan'
    );
    expect(
      detectMode({ requestedMode: 'conductor', input: '随便' }).mode
    ).toBe('conductor');
    expect(normalizeAgentMode('normal')).toBeUndefined();
  });

  it('does not treat multi-dir phrasing as conductor', () => {
    const result = detectMode({
      requestedMode: 'auto',
      input: '给巡检任务增加任务来源字段，前后端联动，管理端也展示'
    });
    expect(result.mode).toBe('auto');
  });

  it('auto-detects conductor orchestration phrasing', () => {
    const result = detectMode({
      requestedMode: 'auto',
      input: '用指挥家模式：高级模型拆任务，经济模型执行再验收'
    });
    expect(result.mode).toBe('conductor');
    expect(result.requiresApproval).toBe(true);
  });

  it('auto-detects plan-first phrasing as plan', () => {
    const result = detectMode({
      requestedMode: 'auto',
      input: '先规划再改登录流程，方案确认后再动手'
    });

    expect(result.mode).toBe('plan');
    expect(result.requiresApproval).toBe(true);
  });
});
