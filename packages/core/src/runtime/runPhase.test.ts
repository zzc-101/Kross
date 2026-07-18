import { describe, expect, it } from 'vitest';

import { classifyToolCallPhase, phaseForLifecycleEvent } from './runPhase';

describe('runPhase', () => {
  it('classifies read, planning, and mutation tools', () => {
    expect(classifyToolCallPhase(call('Read', { path: 'src/a.ts' })).phase).toBe(
      'inspect'
    );
    expect(classifyToolCallPhase(call('TodoWrite', { todos: [] })).phase).toBe(
      'plan'
    );
    expect(classifyToolCallPhase(call('Edit', { path: 'src/a.ts' })).phase).toBe(
      'act'
    );
  });

  it('recognizes verification commands instead of treating every shell call as act', () => {
    const classified = classifyToolCallPhase(
      call('Bash', { command: 'npm run typecheck && npm test' })
    );

    expect(classified.phase).toBe('verify');
    expect(classified.verification?.kinds).toEqual(
      expect.arrayContaining(['typecheck', 'test'])
    );
  });

  it('only treats process polling as verification when a check is pending', () => {
    const poll = call('ProcessPoll', { processId: 'process-1' });

    expect(classifyToolCallPhase(poll).phase).toBe('act');
    expect(
      classifyToolCallPhase(poll, undefined, { verificationPending: true }).phase
    ).toBe('verify');
  });

  it('maps lifecycle events to observable phases', () => {
    expect(phaseForLifecycleEvent('plan.created')).toBe('plan');
    expect(phaseForLifecycleEvent('conductor.execution.started')).toBe('act');
    expect(phaseForLifecycleEvent('review.completed')).toBe('review');
    expect(phaseForLifecycleEvent('run.completed')).toBeUndefined();
  });
});

function call(name: string, input: unknown) {
  return { id: `call-${name}`, name, input };
}
