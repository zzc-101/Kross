import { describe, expect, it } from 'vitest';

import { classifyToolCallPhase, phaseForLifecycleEvent } from './runPhase';

describe('runPhase', () => {
  it('classifies read, preparation, and mutation tools', () => {
    expect(classifyToolCallPhase(call('Read', { path: 'src/a.ts' })).phase).toBe(
      'inspect'
    );
    expect(classifyToolCallPhase(call('TodoWrite', { todos: [] })).phase).toBe(
      'prepare'
    );
    expect(classifyToolCallPhase(call('Edit', { path: 'src/a.ts' })).phase).toBe(
      'act'
    );
  });

  it('maps lifecycle events to observable phases', () => {
    expect(phaseForLifecycleEvent('review.completed')).toBe('review');
    expect(phaseForLifecycleEvent('run.completed')).toBeUndefined();
  });
});

function call(name: string, input: unknown) {
  return { id: `call-${name}`, name, input };
}
