import { describe, expect, it } from 'vitest';

import {
  diffLineKind,
  parseDiffInspection,
  traceRunIds
} from './inspection';

describe('inspection helpers', () => {
  it('splits diff summaries from patches', () => {
    expect(
      parseDiffInspection('Diff\nrun: r1\n\n--- KROSS PATCH ---\n@@ -1 +1 @@\n-old\n+new')
    ).toEqual({
      summary: 'Diff\nrun: r1',
      patch: '@@ -1 +1 @@\n-old\n+new'
    });
  });

  it('extracts safe run ids from trace lists and details', () => {
    expect(
      traceRunIds('1. run-1 completed\n2. run_2 failed\nTrace: run-1')
    ).toEqual(['run-1', 'run_2']);
  });

  it('classifies patch lines without treating file headers as edits', () => {
    expect(diffLineKind('+++ b/a.ts')).toBe('meta');
    expect(diffLineKind('+const value = 1')).toBe('addition');
    expect(diffLineKind('-const value = 0')).toBe('deletion');
    expect(diffLineKind('@@ -1 +1 @@')).toBe('hunk');
  });
});
