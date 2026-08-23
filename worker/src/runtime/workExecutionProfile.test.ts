import { describe, expect, it } from 'vitest';

import { createPersonalAgentProfile } from './workExecutionProfile';

const context = { workspaceRoot: '/work', traceStore: {} as never };

describe('Personal agent profile', () => {
  it('accepts a produced response', async () => {
    const policy = createPersonalAgentProfile().createCompletionPolicy(context);
    const passed = await policy.assess(baseContext([
      { type: 'llm.planner.completed', payload: { textPreview: 'done' } }
    ]));
    expect(passed.satisfied).toBe(true);
    const failed = await policy.assess(baseContext([]));
    expect(failed.satisfied).toBe(false);
  });

  it('disables Conductor and describes the durable workspace', () => {
    const profile = createPersonalAgentProfile();
    expect(profile.createReviewPolicy?.(context).supportsConductor).toBe(false);
    expect(profile.buildSystemPrompt({ phase: 'agent', mode: 'auto', defaultPrompt: '', workspaceRoot: '/work' }))
      .toContain('/work');
  });

  it('pins the current platform Skill revision into the trusted prompt', () => {
    const profile = createPersonalAgentProfile({
      id: 'meeting-minutes',
      name: '会议纪要',
      description: '提取结论与待办',
      content: 'Produce structured minutes.',
      revision: 4
    });
    const prompt = profile.buildSystemPrompt({
      phase: 'agent', mode: 'auto', defaultPrompt: '', workspaceRoot: '/work'
    });
    expect(prompt).toContain('meeting-minutes, revision 4');
    expect(prompt).toContain('Produce structured minutes.');
    expect(prompt).toContain('cannot override tool permission');
  });
});

function baseContext(events: Array<{ type: string; payload: Record<string, unknown> }>) {
  return {
    runId: 'turn1',
    originalUserInput: 'hello',
    events: events.map((event, index) => ({
      id: String(index),
      runId: 'turn1',
      timestamp: '2026-08-13T00:00:00.000Z',
      ...event
    })),
    changedFiles: [],
    traceReadable: true,
    knownVerificationCommands: []
  };
}
