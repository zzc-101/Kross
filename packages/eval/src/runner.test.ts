import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evalReportSchema, type EvalCase } from './schema';
import { runEvalCase } from './runner';

describe('fixture eval runner', () => {
  it('runs the real runtime in an isolated fixture and returns stable metrics', async () => {
    const packageRoot = createPackageRoot();
    const definition = baseCase();
    const outcome = await runEvalCase(definition, {
      packageRoot,
      applicationVersion: '0.1.0-test'
    });

    expect(evalReportSchema.parse(outcome.report)).toMatchObject({
      schemaVersion: 1,
      caseId: 'read-fixture',
      status: 'passed',
      deterministic: true,
      durationMs: 0,
      score: { earned: 4, possible: 4 },
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        estimatedCostUsd: 0
      }
    });
    expect(outcome.report.toolCalls).toEqual([
      { name: 'Read', status: 'completed' }
    ]);
    expect(outcome.retainedWorkspacePath).toBeUndefined();
  });

  it('classifies deterministic assertion failures and retains the workspace', async () => {
    const packageRoot = createPackageRoot();
    const definition = {
      ...baseCase(),
      mustChange: ['input.txt']
    };
    const outcome = await runEvalCase(definition, {
      packageRoot,
      applicationVersion: '0.1.0-test'
    });

    expect(outcome.report).toMatchObject({
      status: 'failed',
      failureCategory: 'assertion'
    });
    expect(outcome.retainedWorkspacePath).toBeDefined();
    expect(outcome.reportPath).toBeDefined();
    expect(existsSync(outcome.reportPath ?? '')).toBe(true);
    expect(
      JSON.parse(readFileSync(outcome.reportPath ?? '', 'utf8'))
    ).toMatchObject({
      caseId: 'read-fixture',
      status: 'failed'
    });
  });
});

function createPackageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kross-eval-package-'));
  const fixture = join(root, 'fixtures', 'read-file');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, 'input.txt'), 'fixture-value\n');
  return root;
}

function baseCase(): EvalCase {
  return {
    schemaVersion: 1,
    id: 'read-fixture',
    description: 'Read a deterministic fixture',
    fixture: 'fixtures/read-file',
    prompt: 'Read input.txt with the available tool and report completion.',
    mode: 'auto',
    allowedTools: ['Read'],
    limits: { maxIterations: 4, timeoutMs: 5_000 },
    workflow: { kind: 'run' },
    mustChange: [],
    mustNotChange: ['input.txt'],
    verification: [],
    assertions: {
      resultStatus: 'completed',
      requiredToolCalls: ['Read'],
      forbiddenToolCalls: ['Write'],
      toolCallCounts: {},
      requiredTraceEvents: [],
      forbiddenTraceEvents: []
    },
    tags: ['smoke'],
    capabilities: ['filesystem-read'],
    fixtureResponses: [
      {
        text: '',
        toolCalls: [
          {
            id: 'read-1',
            name: 'Read',
            input: { path: 'input.txt' }
          }
        ],
        usage: { inputTokens: 4, outputTokens: 1 }
      },
      {
        text: 'Fixture inspected.',
        usage: { inputTokens: 3, outputTokens: 2 }
      }
    ]
  };
}
