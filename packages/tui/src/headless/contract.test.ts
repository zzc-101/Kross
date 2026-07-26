import { describe, expect, it } from 'vitest';

import {
  headlessEventSchema,
  headlessExecRequestSchema,
  headlessExitCodes,
  serializeHeadlessEvent
} from './contract';

describe('headless execution contract', () => {
  it('keeps distinct process exit codes for machine callers', () => {
    expect(new Set(Object.values(headlessExitCodes)).size).toBe(
      Object.keys(headlessExitCodes).length
    );
    expect(headlessExitCodes).toMatchObject({
      success: 0,
      usage: 2,
      approvalRequired: 4,
      verificationFailed: 6,
      interrupted: 130
    });
  });

  it('requires explicit JSON mode and preserves the permission choice', () => {
    expect(
      headlessExecRequestSchema.parse({
        schemaVersion: 1,
        input: { source: 'argument', task: 'inspect the project' },
        mode: 'auto',
        permission: 'default',
        json: true
      })
    ).toMatchObject({
      permission: 'default',
      json: true
    });
  });

  it('serializes one validated event per NDJSON line', () => {
    const line = serializeHeadlessEvent({
      schemaVersion: 1,
      type: 'text.delta',
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: 'run-1',
      sessionId: 'session-1',
      sequence: 2,
      data: { text: 'first line\nsecond line' }
    });

    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(headlessEventSchema.parse(JSON.parse(line))).toMatchObject({
      type: 'text.delta',
      data: { text: 'first line\nsecond line' }
    });
  });

  it('rejects events without run and session identifiers', () => {
    expect(() =>
      headlessEventSchema.parse({
        schemaVersion: 1,
        type: 'error',
        timestamp: '2026-01-01T00:00:00.000Z',
        sequence: 0,
        data: {
          category: 'configuration',
          message: 'missing model',
          retryable: false
        }
      })
    ).toThrow();
  });
});
