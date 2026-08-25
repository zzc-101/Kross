import { describe, expect, it } from 'vitest';
import { RunProgressMonitor } from './runProgressMonitor';

describe('RunProgressMonitor', () => {
  it('warns and stalls when changing inspection calls do not create progress', () => {
    const monitor = new RunProgressMonitor(2, 3);
    expect(monitor.observe([{ id: '1', name: 'Rg', input: { pattern: 'a' } }]).state).toBe('idle');
    expect(monitor.observe([{ id: '2', name: 'Read', input: { path: 'b' } }]).state).toBe('warn');
    expect(monitor.observe([{ id: '3', name: 'Stat', input: { path: 'c' } }]).state).toBe('stalled');
  });

  it('resets after a state-changing action', () => {
    const monitor = new RunProgressMonitor(2, 3);
    monitor.observe([{ id: '1', name: 'Read', input: { path: 'a' } }]);
    expect(monitor.observe([{ id: '2', name: 'Edit', input: {} }])).toMatchObject({
      state: 'progress', consecutiveNoProgress: 0
    });
    monitor.observe([{ id: '3', name: 'Rg', input: { pattern: 'a' } }]);
    expect(monitor.observe([{ id: '4', name: 'Task', input: {} }])).toMatchObject({
      state: 'progress', consecutiveNoProgress: 0
    });
  });
});
