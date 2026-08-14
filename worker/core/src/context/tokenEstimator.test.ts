import { describe, expect, it } from 'vitest';

import {
  TokenEstimator,
  estimateMessageTokens,
  estimateTextTokens
} from './tokenEstimator';
import type { LlmMessage } from '../llm/types';

describe('TokenEstimator', () => {
  it('estimates ASCII text at roughly 4 chars per token', () => {
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('a'.repeat(40))).toBe(10);
  });

  it('estimates CJK text at roughly 1 char per token', () => {
    expect(estimateTextTokens('你好世界')).toBe(4);
  });

  it('includes toolCalls JSON and tool message body', () => {
    const assistant: LlmMessage = {
      role: 'assistant',
      content: 'ok',
      toolCalls: [{ id: '1', name: 'Read', input: { path: 'a.ts' } }]
    };
    const tool: LlmMessage = {
      role: 'tool',
      toolCallId: '1',
      name: 'Read',
      content: 'file body'
    };
    expect(estimateMessageTokens(assistant)).toBeGreaterThan(estimateMessageTokens({
      role: 'assistant',
      content: 'ok'
    }));
    expect(estimateMessageTokens(tool)).toBeGreaterThan(4);
  });

  it('calibrates with EMA and clamps factor', () => {
    const estimator = new TokenEstimator({ minFactor: 0.5, maxFactor: 2.0 });
    const messages: LlmMessage[] = [{ role: 'user', content: 'x'.repeat(400) }];
    const raw = estimator.estimate(messages);
    estimator.calibrate(raw, Math.floor(raw / 4));
    expect(estimator.getCalibrationFactor()).toBeGreaterThanOrEqual(0.5);
    expect(estimator.getCalibrationFactor()).toBeLessThanOrEqual(2.0);
  });

  it('converges to the actual-to-raw ratio across repeated calibration', () => {
    const estimator = new TokenEstimator({
      minFactor: 0.5,
      maxFactor: 3,
      emaAlpha: 0.3
    });
    const rawTokens = 100;

    for (let index = 0; index < 30; index += 1) {
      estimator.calibrate(rawTokens, 200);
    }

    expect(estimator.getCalibrationFactor()).toBeCloseTo(2, 3);
  });

  it('resetCalibration restores factor to 1', () => {
    const estimator = new TokenEstimator();
    estimator.calibrate(100, 50);
    estimator.resetCalibration();
    expect(estimator.getCalibrationFactor()).toBe(1);
  });
});
