import { describe, expect, it } from 'vitest';
import { RunProgressMonitor, VerificationFailureLedger } from './runProgressMonitor';

describe('RunProgressMonitor', () => {
  it('warns and stalls when changing inspection calls do not create progress', () => {
    const monitor = new RunProgressMonitor(2, 3);
    expect(monitor.observe([{ id: '1', name: 'Rg', input: { pattern: 'a' } }]).state).toBe('idle');
    expect(monitor.observe([{ id: '2', name: 'Read', input: { path: 'b' } }]).state).toBe('warn');
    expect(monitor.observe([{ id: '3', name: 'Bash', input: { command: 'git diff' } }]).state).toBe('stalled');
  });

  it('resets after a mutation or verification command', () => {
    const monitor = new RunProgressMonitor(2, 3);
    monitor.observe([{ id: '1', name: 'Read', input: { path: 'a' } }]);
    expect(monitor.observe([{ id: '2', name: 'Edit', input: {} }])).toMatchObject({
      state: 'progress', consecutiveNoProgress: 0
    });
    monitor.observe([{ id: '3', name: 'Rg', input: { pattern: 'a' } }]);
    expect(monitor.observe([{ id: '4', name: 'Bash', input: { command: 'npm test' } }])).toMatchObject({
      state: 'progress', consecutiveNoProgress: 0
    });
  });
});

describe('VerificationFailureLedger', () => {
  it('rejects and then stalls repeated verification without a mutation', () => {
    const ledger = new VerificationFailureLedger();
    expect(ledger.observe({ lastMutationIndex: 4, reason: 'tests failed' }).state).toBe('new');
    expect(ledger.observe({ lastMutationIndex: 4, reason: 'tests failed' }).state).toBe('rejected');
    expect(ledger.observe({ lastMutationIndex: 4, reason: 'tests failed' }).state).toBe('stalled');
  });

  it('starts a new strategy after the workspace changes', () => {
    const ledger = new VerificationFailureLedger();
    ledger.observe({ lastMutationIndex: 4, reason: 'tests failed' });
    expect(ledger.observe({ lastMutationIndex: 8, reason: 'tests failed' })).toMatchObject({
      state: 'new', attempts: 1
    });
  });
});
