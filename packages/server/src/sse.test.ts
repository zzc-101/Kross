import { describe, expect, it } from 'vitest';

import { SseService } from './sse';

describe('SSE cursor replay', () => {
  it('emits protocol v2 envelopes and forwards opaque cursor and tenant filters', async () => {
    const calls: unknown[][] = [];
    const events = { replay: async (...args: unknown[]) => {
      calls.push(args);
      return [{
        eventId: 'event_a', organizationId: 'org_a', projectId: 'project_a', taskId: 'task_a',
        runId: 'run_a', generation: 1, seq: 1, type: 'task.created', timestamp: '2026-08-12T00:00:00.000Z',
        payload: { type: 'task.created', data: {
          id: 'task_a', organizationId: 'org_a', projectId: 'project_a', type: 'general', status: 'open',
          title: 'Task', objectivePreview: 'Objective', messageCount: 0, createdBy: 'user_a',
          createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z'
        } }
      }];
    } };
    const chunks = await new SseService(events as never).replay(
      { organizationId: 'org_a', userId: 'user_a', membershipId: 'membership_a', role: 'viewer' },
      'event_previous', { runId: 'run_a' }
    );
    expect(chunks[0]).toContain('event: task.created');
    expect(chunks[0]).toContain('"protocolVersion":2');
    expect(calls[0]?.[1]).toBe('event_previous');
  });
});
