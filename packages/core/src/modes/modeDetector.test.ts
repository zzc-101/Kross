import { describe, expect, it } from 'vitest';

import { detectMode } from './modeDetector';

describe('detectMode', () => {
  it('keeps explicit normal mode', () => {
    const result = detectMode({
      requestedMode: 'normal',
      input: '给登录接口补测试'
    });

    expect(result.mode).toBe('normal');
    expect(result.requiresApproval).toBe(false);
  });

  it('keeps explicit conductor mode and aliases cross-repo', () => {
    expect(
      detectMode({
        requestedMode: 'conductor',
        input: '解释一下这个工具'
      }).mode
    ).toBe('conductor');
    expect(
      detectMode({
        requestedMode: 'cross-repo',
        input: '解释一下这个工具'
      }).mode
    ).toBe('conductor');
  });

  it('auto-detects front/back linkage as conductor', () => {
    const result = detectMode({
      requestedMode: 'auto',
      input: '给巡检任务增加任务来源字段，前后端联动，管理端也展示'
    });

    expect(result.mode).toBe('conductor');
    expect(result.requiresApproval).toBe(true);
  });

  it('falls back to normal mode for local implementation requests', () => {
    const result = detectMode({
      requestedMode: 'auto',
      input: '帮我给当前模块补一个单元测试'
    });

    expect(result.mode).toBe('normal');
  });
});
