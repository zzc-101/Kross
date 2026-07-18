import { describe, expect, it } from 'vitest';

import {
  aggregateConductorVerification,
  parseConductorReviewVerdict,
  type ConductorTaskOutcome
} from './conductorOrchestration';

describe('aggregateConductorVerification', () => {
  it('requires every worker mutation to have passing verification', () => {
    const report = aggregateConductorVerification([
      outcome('implemented', ['src/a.ts'], 'passed', ['npm test']),
      outcome('unverified', ['src/b.ts'], 'not-run', [])
    ]);

    expect(report).toMatchObject({
      status: 'not-run',
      commands: ['npm test']
    });
  });

  it('propagates failed worker verification', () => {
    const report = aggregateConductorVerification([
      outcome('failed-check', ['src/a.ts'], 'failed', ['npm test'])
    ]);

    expect(report.status).toBe('failed');
    expect(report.evidence).toContain('failed-check: npm test: exit=1');
  });

  it('returns not-needed for read-only worker results', () => {
    expect(
      aggregateConductorVerification([
        outcome('explore', [], 'not-needed', [])
      ]).status
    ).toBe('not-needed');
  });
});

describe('parseConductorReviewVerdict', () => {
  it('uses the final explicit verdict', () => {
    expect(
      parseConductorReviewVerdict(
        'draft VERDICT: NEEDS_WORK\nfixed concerns\nVERDICT: PASS'
      )
    ).toBe('pass');
    expect(parseConductorReviewVerdict('VERDICT: NEEDS_WORK')).toBe(
      'needs-work'
    );
  });

  it('does not infer acceptance from natural language', () => {
    expect(parseConductorReviewVerdict('looks good to me')).toBeUndefined();
  });
});

function outcome(
  taskId: string,
  changedFiles: string[],
  status: ConductorTaskOutcome['verification']['status'],
  commands: string[]
): ConductorTaskOutcome {
  return {
    taskId,
    title: taskId,
    status: 'completed',
    summary: 'done',
    changedFiles,
    evidence: [],
    risks: [],
    needsReview: [],
    verification: {
      status,
      commands,
      evidence: status === 'failed' ? ['npm test: exit=1'] : []
    }
  };
}
