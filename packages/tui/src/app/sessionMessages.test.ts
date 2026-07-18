import { describe, expect, it } from 'vitest';

import { fromStoredSessionMessage, toStoredSessionMessage } from './sessionMessages';

describe('sessionMessages verification', () => {
  it('round-trips a structured verification summary', () => {
    const verification = {
      status: 'passed' as const,
      commands: ['npm test'],
      evidence: ['npm test: passed']
    };
    const stored = toStoredSessionMessage({
      id: 1,
      from: 'system',
      text: '验证通过',
      verification
    });

    expect(stored.verification).toEqual(verification);
    expect(fromStoredSessionMessage(stored).verification).toEqual(verification);
  });

  it('ignores malformed persisted verification data', () => {
    const restored = fromStoredSessionMessage({
      id: 2,
      from: 'system',
      text: 'old message',
      verification: { status: 'green' }
    });

    expect(restored.verification).toBeUndefined();
  });
});
