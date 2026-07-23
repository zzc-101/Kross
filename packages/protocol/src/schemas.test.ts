import { describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  clientCommandSchema,
  eventEnvelopeSchema
} from './index';

describe('cloud protocol', () => {
  it('rejects commands from an incompatible protocol version', () => {
    expect(
      clientCommandSchema.safeParse({
        protocolVersion: 2,
        requestId: 'r1',
        type: 'workspace.list'
      }).success
    ).toBe(false);
  });

  it('validates replayable event envelopes', () => {
    expect(
      eventEnvelopeSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        workspaceId: 'w1',
        sessionId: 's1',
        seq: 1,
        timestamp: new Date().toISOString(),
        event: { type: 'request.accepted', requestId: 'r1' }
      }).seq
    ).toBe(1);
  });

  it('validates workspace provisioning progress events', () => {
    const envelope = eventEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: '$gateway',
      seq: 0,
      timestamp: new Date().toISOString(),
      event: {
        type: 'workspace.progress',
        data: {
          requestId: 'create-1',
          workspaceId: 'w1',
          name: 'demo',
          stage: 'cloning',
          message: '正在克隆'
        }
      }
    });
    expect(envelope.event.type).toBe('workspace.progress');
  });
});
