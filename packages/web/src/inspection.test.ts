import { describe, expect, it } from 'vitest';

import {
  diffLineKind,
  parseTracePresentation,
  traceLineKind,
  traceRunIds
} from './inspection';

describe('inspection helpers', () => {
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

  it('parses trace facts and sections for structured presentation', () => {
    expect(
      parseTracePresentation(
        'Trace: run-1\nstatus: failed\nllm: calls=2 · rate-limited=1\nhighlights:\n- llm.call.failed error=network'
      )
    ).toEqual({
      kind: 'detail',
      runId: 'run-1',
      facts: [
        { label: 'status', value: 'failed' },
        { label: 'llm', value: 'calls=2 · rate-limited=1' }
      ],
      sections: [
        {
          title: 'highlights',
          lines: ['- llm.call.failed error=network']
        }
      ]
    });
  });

  it('highlights network and rate-limit failures', () => {
    expect(traceLineKind('error=network')).toBe('error');
    expect(traceLineKind('rate-limited=1')).toBe('error');
    expect(traceLineKind('retry in 3s')).toBe('warning');
  });
});
