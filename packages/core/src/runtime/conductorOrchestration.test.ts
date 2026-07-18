import { describe, expect, it } from 'vitest';

import {
  aggregateConductorVerification,
  parseConductorReviewVerdict,
  parseReplannedConductorTask,
  type ConductorValidationOutcome,
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

  it('does not require command evidence for documentation-only changes', () => {
    expect(
      aggregateConductorVerification([
        outcome('docs', ['docs/guide.md'], 'not-run', [])
      ]).status
    ).toBe('not-needed');
  });

  it('uses independent validation evidence for an unverified worker change', () => {
    const validation: ConductorValidationOutcome = {
      status: 'completed',
      summary: 'tests passed',
      changedFiles: ['src/a.ts'],
      verification: {
        status: 'passed',
        commands: ['npm test'],
        evidence: ['npm test: exit=0']
      },
      evidence: [],
      risks: []
    };

    expect(
      aggregateConductorVerification(
        [outcome('implemented', ['src/a.ts'], 'not-run', [])],
        [validation]
      )
    ).toMatchObject({ status: 'passed', commands: ['npm test'] });
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

describe('parseReplannedConductorTask', () => {
  it('preserves task scope while replacing title and prompt', () => {
    expect(
      parseReplannedConductorTask(
        {
          id: 'api',
          title: 'old',
          prompt: 'old prompt',
          repoId: 'api-root',
          dependsOn: ['inspect']
        },
        '```json\n{"title":"smaller","prompt":"new prompt"}\n```'
      )
    ).toEqual({
      id: 'api',
      title: 'smaller',
      prompt: 'new prompt',
      repoId: 'api-root',
      dependsOn: ['inspect']
    });
  });

  it('rejects malformed recovery output', () => {
    expect(
      parseReplannedConductorTask(
        { id: 'a', title: 'a', prompt: 'a' },
        'not-json'
      )
    ).toBeUndefined();
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
