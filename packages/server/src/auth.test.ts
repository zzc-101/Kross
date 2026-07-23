import { describe, expect, it } from 'vitest';

import { readBearerToken, tokenMatches } from './auth';

describe('gateway authentication', () => {
  it('parses and compares bearer tokens', () => {
    expect(readBearerToken('Bearer test-token')).toBe('test-token');
    expect(tokenMatches('test-token', 'test-token')).toBe(true);
    expect(tokenMatches('wrong', 'test-token')).toBe(false);
  });
});
