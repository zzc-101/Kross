import { describe, expect, it } from 'vitest';

import { createWorkExecutionProfile, WorkRunEvidence, type WorkExecutionSpec } from './workExecutionProfile';

const runSpec = {
  runId: 'run1',
  task: { type: 'general', title: 'T', objective: 'O', constraints: [], acceptanceCriteria: [] },
  sources: [],
  policy: { allowedToolNames: ['Read'] }
} as WorkExecutionSpec;
const context = { workspaceRoot: '/work', traceStore: {} as never };

describe('Work execution profile', () => {
  it('accepts a target response and rejects pending approval', async () => {
    const evidence = new WorkRunEvidence();
    const policy = createWorkExecutionProfile({ runSpec, evidence }).createCompletionPolicy(context);
    const responseEvent = [{ type: 'llm.planner.completed', payload: { textPreview: 'done' } }];
    expect((await policy.assess(baseContext(responseEvent))).satisfied).toBe(true);
    evidence.addPendingApproval('approval1');
    expect((await policy.assess(baseContext(responseEvent))).satisfied).toBe(false);
  });

  it('is subtractive for tool visibility and disables Conductor', () => {
    const profile = createWorkExecutionProfile({ runSpec, evidence: new WorkRunEvidence() });
    expect(profile.getToolPolicy?.(context).isToolVisible?.({ name: 'Read' } as never)).toBe(true);
    expect(profile.getToolPolicy?.(context).isToolVisible?.({ name: 'Bash' } as never)).toBe(false);
    expect(profile.createReviewPolicy?.(context).supportsConductor).toBe(false);
    expect(profile.buildSystemPrompt({ phase: 'agent', mode: 'auto', defaultPrompt: '', workspaceRoot: '/work' })).toContain('untrusted user-provided data');
  });
});

function baseContext(events: Array<{ type: string; payload: Record<string, unknown> }>) {
  return {
    runId: 'run1',
    originalUserInput: 'work',
    events: events.map((event, index) => ({ id: String(index), runId: 'run1', timestamp: '2026-08-12T00:00:00.000Z', ...event })),
    changedFiles: [],
    traceReadable: true,
    knownVerificationCommands: []
  };
}
