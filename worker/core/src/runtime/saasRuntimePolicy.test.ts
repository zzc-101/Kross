import { describe, expect, it } from 'vitest';

import {
  buildSaasSystemPrompt,
  createSaasCompletionPolicy
} from './saasRuntimePolicy';

describe('SaaS runtime policy', () => {
  it('builds the work-agent prompt and injects the active platform Skill', () => {
    const prompt = buildSaasSystemPrompt({
      phase: 'agent',
      activeSkill: {
        id: 'meeting-minutes',
        name: '会议纪要',
        description: '提取结论与待办',
        content: 'Produce structured minutes.',
        revision: 4
      }
    });

    expect(prompt).toContain('work assistant');
    expect(prompt).toContain('meeting-minutes, revision 4');
    expect(prompt).toContain('Produce structured minutes.');
    expect(prompt).not.toContain('software-engineering');
  });

  it('requires a real model response before completion', async () => {
    const policy = createSaasCompletionPolicy();
    const base = {
      runId: 'run-1',
      originalUserInput: 'hello',
      changedFiles: [],
      traceReadable: true,
      knownVerificationCommands: []
    };

    expect(await policy.assess({ ...base, events: [] })).toMatchObject({
      satisfied: false,
      status: 'failed'
    });
    expect(
      await policy.assess({
        ...base,
        events: [
          {
            id: 'event-1',
            runId: 'run-1',
            timestamp: '2026-08-25T00:00:00.000Z',
            type: 'llm.planner.completed',
            payload: { textPreview: 'done' }
          }
        ]
      })
    ).toMatchObject({ satisfied: true, status: 'passed' });
  });
});
