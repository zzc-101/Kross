import { afterEach, describe, expect, it } from 'vitest';

import { initI18n, setLocale } from '../i18n/locale';
import { promptCatalogs } from './promptCatalog';
import {
  AGENT_EXECUTION_PROMPT_KEYS,
  renderAgentModeOverlay,
  renderAgentExecutionPrompt,
  renderModePhasePrompt,
  renderSubagentExecutionPrompt,
  renderPrompt
} from './promptRenderer';

describe('prompt catalog', () => {
  afterEach(() => {
    initI18n('zh');
  });

  it('keeps zh and en keys aligned with non-empty templates', () => {
    expect(Object.keys(promptCatalogs.en).sort()).toEqual(
      Object.keys(promptCatalogs.zh).sort()
    );
    for (const catalog of Object.values(promptCatalogs)) {
      for (const value of Object.values(catalog)) {
        const text = Array.isArray(value) ? value.join('\n') : value;
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('renders the current locale at call time', () => {
    initI18n('zh');
    expect(renderPrompt('agent.execution.base')).toContain('你是 Kross');

    setLocale('en');
    expect(renderPrompt('agent.execution.base')).toContain('You are Kross');
  });

  it('interpolates required prompt parameters', () => {
    expect(
      renderPrompt('agent.execution.modeContext', {
        sessionMode: 'plan',
        mode: 'auto'
      })
    ).toBe('会话 Mode：plan；本轮策略：auto。');
  });

  it('composes the execution contract with optional mode context', () => {
    const prompt = renderAgentExecutionPrompt({
      sessionMode: 'plan',
      mode: 'auto',
      locale: 'en'
    });

    expect(prompt).toContain('First identify what the user actually requests');
    expect(prompt).toContain('Preserve existing user changes');
    expect(prompt).toContain('Work loop — Verify:');
    expect(prompt).toContain('Claim completion only when');
    expect(prompt).toContain('Auto mode:');
    expect(prompt).toContain('Session mode: plan');
  });

  it('adds exactly the overlay for the active main-agent mode', () => {
    const auto = renderAgentExecutionPrompt({ mode: 'auto', locale: 'en' });
    const plan = renderAgentExecutionPrompt({ mode: 'plan', locale: 'en' });
    const conductor = renderAgentExecutionPrompt({
      mode: 'conductor',
      locale: 'en'
    });

    expect(auto).toContain('Auto mode:');
    expect(auto).not.toContain('Plan mode:');
    expect(plan).toContain('Plan mode:');
    expect(plan).not.toContain('Conductor mode:');
    expect(conductor).toContain('Conductor mode:');
    expect(conductor).not.toContain('Auto mode:');
  });

  it('reuses mode overlays in specialized plan and conductor phases', () => {
    const plan = renderModePhasePrompt('plan.body', 'plan', 'en');
    const conductorPlan = renderModePhasePrompt(
      'conductor.plan',
      'conductor',
      'en'
    );
    const review = renderModePhasePrompt(
      'conductor.review',
      'conductor',
      'en'
    );

    expect(plan.startsWith(renderAgentModeOverlay('plan', 'en'))).toBe(true);
    expect(plan).toContain('executable development plan');
    expect(conductorPlan).toContain('Conductor planning phase:');
    expect(conductorPlan).not.toContain('Conductor review phase:');
    expect(review.startsWith(renderAgentModeOverlay('conductor', 'en'))).toBe(
      true
    );
    expect(review).toContain('Conductor review phase:');
    expect(review).not.toContain('Conductor planning phase:');
    expect(review).toContain('reviewing worker-agent results');
  });

  it('composes shared rules with distinct subagent mode overlays', () => {
    const explore = renderSubagentExecutionPrompt({
      mode: 'explore',
      locale: 'en'
    });
    const general = renderSubagentExecutionPrompt({
      mode: 'general',
      locale: 'en'
    });

    for (const prompt of [explore, general]) {
      expect(prompt).toContain('You are a focused Kross subagent');
      expect(prompt).toContain('Preserve existing user changes');
      expect(prompt).toContain('Work loop — Recover:');
      expect(prompt).not.toContain('SetMode');
    }
    expect(explore).toContain('Explore subagent mode:');
    expect(explore).not.toContain('General subagent mode:');
    expect(general).toContain('General subagent mode:');
    expect(general).not.toContain('Explore subagent mode:');
  });

  it('composes every execution section once and in the declared order', () => {
    const prompt = renderAgentExecutionPrompt({ locale: 'zh' });
    let previousIndex = -1;

    for (const key of AGENT_EXECUTION_PROMPT_KEYS) {
      const section = renderPrompt(key, {}, 'zh');
      const sectionIndex = prompt.indexOf(section);

      expect(sectionIndex).toBeGreaterThan(previousIndex);
      expect(prompt.indexOf(section, sectionIndex + section.length)).toBe(-1);
      previousIndex = sectionIndex;
    }
  });

  it('keeps critical behavior contracts in both locales', () => {
    const zh = renderAgentExecutionPrompt({ locale: 'zh' });
    const en = renderAgentExecutionPrompt({ locale: 'en' });

    expect(zh).toContain('回答、解释、审查、状态报告和诊断默认只授权读取与分析');
    expect(en).toContain('authorize reading and analysis by default');
    expect(zh).toContain('不要提交、推送、发布');
    expect(en).toContain('do not commit, push, publish');
    expect(zh).toContain('验证证据必须来自最后一次相关修改之后');
    expect(en).toContain('after the last relevant mutation');
    expect(zh).toContain('不要在没有新信息或策略变化时机械重复');
    expect(en).toContain('Do not mechanically repeat');
  });

  it('rejects missing prompt parameters', () => {
    expect(() => renderPrompt('agent.execution.modeContext')).toThrow(
      'Missing prompt parameter "sessionMode"'
    );
    expect(() =>
      renderAgentExecutionPrompt({ sessionMode: 'auto' })
    ).toThrow('mode is required when sessionMode is provided');
  });
});
