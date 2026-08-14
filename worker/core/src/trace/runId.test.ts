import { describe, expect, it } from 'vitest';

import { isSafeRunId } from './runId';

describe('isSafeRunId', () => {
  it('accepts normal run ids', () => {
    expect(isSafeRunId('run-mr8un5tg')).toBe(true);
    expect(isSafeRunId('run_1.2')).toBe(true);
  });

  it('rejects path traversal and empty values', () => {
    expect(isSafeRunId('')).toBe(false);
    expect(isSafeRunId('..')).toBe(false);
    expect(isSafeRunId('.')).toBe(false);
    expect(isSafeRunId('../etc')).toBe(false);
    expect(isSafeRunId('a/b')).toBe(false);
    expect(isSafeRunId('a\\b')).toBe(false);
    expect(isSafeRunId('run..id')).toBe(false);
    expect(isSafeRunId('-leading')).toBe(false);
  });
});
