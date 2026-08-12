import { publicEventEnvelopeSchema } from '@kross/protocol';
import { describe, expect, it } from 'vitest';

import { initialRunViewState, reducePublicEvent } from './runReducer';

describe('reducePublicEvent', () => {
  it('deduplicates a replayed cursor and accumulates streaming deltas', () => {
    const first = envelope('event-1', 1, '你');
    const second = envelope('event-2', 2, '好');
    const state1 = reducePublicEvent(initialRunViewState, first);
    const replayed = reducePublicEvent(state1, first);
    const state2 = reducePublicEvent(replayed, second);
    expect(replayed).toBe(state1);
    expect(state2.drafts['message-1']).toBe('你好');
    expect(state2.lastEventId).toBe('event-2');
  });

  it('turns approval requests into renderable summaries', () => {
    const event = publicEventEnvelopeSchema.parse({
      protocolVersion: 2, eventId: 'approval-event', timestamp: '2026-08-12T00:00:00.000Z',
      event: { type: 'run.approval_requested', data: {
        id: 'approval-1', organizationId: 'org-1', projectId: 'project-1', taskId: 'task-1', runId: 'run-1',
        scope: 'run', riskLevel: 'high', actionPreview: '向外部系统提交表单',
        target: { type: 'external_action', actionType: 'submit', idempotencyKey: 'submit-1', argumentsHash: 'a'.repeat(64) },
        status: 'pending', requestedAt: '2026-08-12T00:00:00.000Z'
      } }
    });
    const state = reducePublicEvent(initialRunViewState, event);
    expect(state.approvals[0]).toMatchObject({ kind: 'external_action', status: 'pending', riskLevel: 'high' });
  });
});

function envelope(eventId: string, index: number, delta: string) {
  return publicEventEnvelopeSchema.parse({
    protocolVersion: 2, eventId, timestamp: '2026-08-12T00:00:00.000Z',
    event: { type: 'run.message_delta', data: {
      organizationId: 'org-1', projectId: 'project-1', taskId: 'task-1', runId: 'run-1',
      messageId: 'message-1', index, delta
    } }
  });
}
