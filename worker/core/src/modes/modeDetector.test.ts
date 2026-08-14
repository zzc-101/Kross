import { describe, expect, it } from 'vitest';

import {
  detectMode,
  isModeSwitchRequest,
  normalizeAgentMode
} from './modeDetector';

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

  it('does not hijack a pure mode switch into an approval gate', () => {
    for (const input of [
      '帮我切换指挥家模式',
      '切换到指挥家模式',
      '切到 plan 模式',
      'switch to conductor'
    ]) {
      const result = detectMode({ requestedMode: 'auto', input });
      expect(result.mode).toBe('auto');
      expect(result.requiresApproval).toBe(false);
      expect(result.signals).toContain('mode-switch');
    }
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

describe('isModeSwitchRequest', () => {
  it('detects switch-only utterances', () => {
    expect(isModeSwitchRequest('帮我切换指挥家模式')).toBe(true);
    expect(isModeSwitchRequest('切换到 plan')).toBe(true);
  });

  it('rejects orchestration and work requests', () => {
    expect(
      isModeSwitchRequest('用指挥家模式：高级模型拆任务，经济模型执行再验收')
    ).toBe(false);
    expect(isModeSwitchRequest('指挥家：实现登录修复')).toBe(false);
  });
});
