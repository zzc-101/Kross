import { describe, expect, it } from 'vitest';

import { buildProviderMatrix } from './providerMatrix';
import { evalReportSchema, type EvalReport } from './schema';

describe('buildProviderMatrix', () => {
  it('aggregates only measured compatibility, cost, latency, and errors', () => {
    const reports = [
      report({
        caseId: 'pass',
        status: 'passed',
        durationMs: 10,
        capabilities: ['tools'],
        estimatedCostUsd: 0.01
      }),
      report({
        caseId: 'limited',
        status: 'error',
        durationMs: 30,
        capabilities: ['tools', 'thinking'],
        providerErrorCategory: 'rate-limit'
      })
    ];

    expect(buildProviderMatrix(reports)).toEqual({
      version: 1,
      deterministicOnly: false,
      rows: [{
        provider: 'openai',
        model: 'gpt-test',
        runs: 2,
        passed: 1,
        failed: 1,
        passRate: 0.5,
        capabilities: [
          { capability: 'thinking', passed: 0, failed: 1 },
          { capability: 'tools', passed: 1, failed: 1 }
        ],
        usage: {
          inputTokens: 6,
          outputTokens: 4,
          totalTokens: 10,
          estimatedCostUsd: 0.01,
          pricingCoverage: 'partial'
        },
        latency: { totalMs: 40, meanMs: 20, p95Ms: 30 },
        rateLimitCount: 1,
        errorCategories: { 'rate-limit': 1 }
      }]
    });
  });
});

function report(input: {
  caseId: string;
  status: EvalReport['status'];
  durationMs: number;
  capabilities: string[];
  estimatedCostUsd?: number;
  providerErrorCategory?: EvalReport['providerErrorCategory'];
}): EvalReport {
  return evalReportSchema.parse({
    schemaVersion: 1,
    caseId: input.caseId,
    description: input.caseId,
    deterministic: false,
    workflow: 'run',
    runtime: {
      applicationVersion: '0.1.0',
      promptVersion: 1,
      provider: 'openai',
      model: 'gpt-test'
    },
    status: input.status,
    score: { earned: 0, possible: 0 },
    changedFiles: [],
    verification: [],
    toolCalls: [],
    traceEvents: [],
    toolIterations: 0,
    durationMs: input.durationMs,
    usage: {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      ...(input.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: input.estimatedCostUsd }
        : {})
    },
    assertions: [],
    tags: [],
    capabilities: input.capabilities,
    providerErrorCategory: input.providerErrorCategory
  });
}
