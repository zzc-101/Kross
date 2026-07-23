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
    const current = eventEnvelopeSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        workspaceId: 'w1',
        sessionId: 's1',
        correlationId: 'command-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        event: { type: 'request.accepted', requestId: 'r1' }
      });
    expect(current.seq).toBe(1);
    expect(current.correlationId).toBe('command-1');

    const legacy = { ...current };
    delete legacy.correlationId;
    expect(eventEnvelopeSchema.parse(legacy).correlationId).toBeUndefined();
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

  it('validates session rename commands and updated summaries', () => {
    const command = clientCommandSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'rename-1',
      type: 'session.rename',
      workspaceId: 'w1',
      sessionId: 's1',
      title: '新的会话名称'
    });
    expect(command.type).toBe('session.rename');

    const timestamp = new Date().toISOString();
    const envelope = eventEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: 'w1',
      sessionId: 's1',
      seq: 2,
      timestamp,
      event: {
        type: 'session.updated',
        data: {
          id: 's1',
          title: '新的会话名称',
          preview: '',
          createdAt: timestamp,
          updatedAt: timestamp,
          messageCount: 0
        }
      }
    });
    expect(envelope.event.type).toBe('session.updated');
  });
});
