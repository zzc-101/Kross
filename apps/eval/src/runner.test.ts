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
import type {
  LlmClient,
  LlmRequest,
  LlmStreamChunk,
  LlmUsage
} from '@kross/core';

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
      score: { earned: 5, possible: 5 },
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

  it('runs an enabled case against an injected real Provider client', async () => {
    const packageRoot = createPackageRoot();
    const definition = {
      ...baseCase(),
      realProvider: { enabled: true }
    };
    const outcome = await runEvalCase(definition, {
      packageRoot,
      applicationVersion: '0.1.0-test',
      target: {
        kind: 'provider',
        provider: 'openai',
        model: 'gpt-test',
        maxCostUsd: 0.1,
        client: new PricedScriptClient([
          {
            toolCall: {
              id: 'read-real-1',
              name: 'Read',
              input: { path: 'input.txt' }
            },
            usage: {
              inputTokens: 4,
              outputTokens: 1,
              totalTokens: 5,
              estimatedCostUsd: 0.01
            }
          },
          {
            text: 'Fixture inspected.',
            usage: {
              inputTokens: 3,
              outputTokens: 2,
              totalTokens: 5,
              estimatedCostUsd: 0.01
            }
          }
        ])
      }
    });

    expect(outcome.report).toMatchObject({
      caseId: 'read-fixture',
      deterministic: false,
      status: 'passed',
      runtime: { provider: 'openai', model: 'gpt-test' },
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        estimatedCostUsd: 0.02
      }
    });
    expect(outcome.report.assertions).toContainEqual({
      name: 'cost-budget',
      passed: true,
      details: 'limit=$0.100000 actual=$0.020000'
    });
  });

  it('rejects real Provider execution for cases that are not enabled', async () => {
    const outcome = await runEvalCase(baseCase(), {
      packageRoot: createPackageRoot(),
      applicationVersion: '0.1.0-test',
      target: {
        kind: 'provider',
        provider: 'openai',
        model: 'gpt-test',
        maxCostUsd: 0.1,
        client: new PricedScriptClient([])
      }
    });

    expect(outcome.report).toMatchObject({
      status: 'error',
      failureCategory: 'configuration',
      error: 'Case read-fixture is not enabled for real Provider evaluation'
    });
  });

  it('replaces Bash with an allowlisted Verify tool and strips Provider secrets', async () => {
    const packageRoot = createPackageRoot();
    const command =
      'node -e process.exit(process.env.OPENAI_API_KEY ? 1 : 0)';
    const definition: EvalCase = {
      ...baseCase(),
      allowedTools: ['Bash'],
      mustNotChange: ['input.txt'],
      verification: [{
        name: 'key-isolation',
        command: 'node',
        args: [
          '-e',
          'process.exit(process.env.OPENAI_API_KEY ? 1 : 0)'
        ],
        expectedExitCode: 0,
        timeoutMs: 5_000
      }],
      assertions: {
        ...baseCase().assertions,
        verificationStatus: 'not-needed',
        requiredToolCalls: [],
        forbiddenToolCalls: ['Bash']
      },
      realProvider: { enabled: true }
    };
    const client = new PricedScriptClient([
      {
        toolCall: {
          id: 'verify-real-1',
          name: 'Verify',
          input: { command }
        },
        usage: pricedUsage()
      },
      { text: 'Verified.', usage: pricedUsage() }
    ]);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-reach-verification';
    try {
      const outcome = await runEvalCase(definition, {
        packageRoot,
        applicationVersion: '0.1.0-test',
        target: {
          kind: 'provider',
          provider: 'openai',
          model: 'gpt-test',
          maxCostUsd: 0.1,
          client
        }
      });

      expect(
        outcome.report.status,
        JSON.stringify(outcome.report.assertions, null, 2)
      ).toBe('passed');
      expect(outcome.report.toolCalls).toEqual([
        { name: 'Verify', status: 'completed' }
      ]);
      expect(client.advertisedTools).toContain('Verify');
      expect(client.advertisedTools).not.toContain('Bash');
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
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
    realProvider: { enabled: false },
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

interface ScriptedTurn {
  text?: string;
  toolCall?: {
    id: string;
    name: string;
    input: unknown;
  };
  usage: LlmUsage;
}

class PricedScriptClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly model = 'gpt-test';
  private index = 0;
  private usage?: LlmUsage;
  readonly advertisedTools: string[] = [];

  constructor(private readonly turns: ScriptedTurn[]) {}

  get lastUsage(): LlmUsage | undefined {
    return this.usage;
  }

  async complete(): Promise<never> {
    throw new Error('complete is not used by the Eval runner');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.advertisedTools.splice(
      0,
      this.advertisedTools.length,
      ...(request.tools?.map((tool) => tool.name) ?? [])
    );
    const turn = this.turns[this.index++];
    if (!turn) throw new Error('script exhausted');
    if (turn.text) yield { type: 'text-delta', text: turn.text };
    if (turn.toolCall) yield { type: 'tool-call', call: turn.toolCall };
    this.usage = turn.usage;
    yield { type: 'done', usage: turn.usage };
  }
}

function pricedUsage(): LlmUsage {
  return {
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
    estimatedCostUsd: 0.001
  };
}
