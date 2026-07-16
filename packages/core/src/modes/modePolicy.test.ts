import { describe, expect, it } from 'vitest';

import { resolveModeTurn } from './modePolicy';

describe('resolveModeTurn', () => {
  it('routes auto to agent-loop', () => {
    const { action } = resolveModeTurn({
      requestedMode: 'auto',
      userInput: '修个 typo',
      planApproved: false,
      hasLlm: true
    });
    expect(action).toEqual({ type: 'agent-loop', mode: 'auto' });
  });

  it('routes plan to plan-gate-flow', () => {
    const { action } = resolveModeTurn({
      requestedMode: 'plan',
      userInput: '实现登录',
      planApproved: false,
      hasLlm: true
    });
    expect(action).toEqual({ type: 'plan-gate-flow', mode: 'plan' });
  });

  it('routes conductor to conductor-gate-flow', () => {
    const { action } = resolveModeTurn({
      requestedMode: 'conductor',
      userInput: '指挥家拆任务',
      planApproved: false,
      hasLlm: true
    });
    expect(action).toEqual({ type: 'conductor-gate-flow', mode: 'conductor' });
  });

  it('resumes approved plan via agent-loop with planText', () => {
    const { action } = resolveModeTurn({
      requestedMode: 'plan',
      userInput: '实现登录',
      planApproved: true,
      hasLlm: true,
      pending: {
        kind: 'plan',
        goal: '实现登录',
        mode: 'plan',
        planText: '1. 改 auth'
      }
    });
    expect(action).toEqual({
      type: 'agent-loop',
      mode: 'plan',
      planText: '1. 改 auth'
    });
  });

  it('resumes approved conductor via conductor-execute', () => {
    const pending = {
      kind: 'conductor' as const,
      goal: 'g',
      mode: 'conductor' as const,
      plan: {
        goal: 'g',
        tasks: [{ id: 't1', title: 'A', prompt: 'do A' }]
      }
    };
    const { action } = resolveModeTurn({
      requestedMode: 'conductor',
      userInput: 'g',
      planApproved: true,
      hasLlm: true,
      pending
    });
    expect(action.type).toBe('conductor-execute');
  });
});
