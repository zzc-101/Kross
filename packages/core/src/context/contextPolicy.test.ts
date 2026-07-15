import { describe, expect, it } from 'vitest';

import { createContextPolicy } from './contextPolicy';

describe('createContextPolicy', () => {
  it('computes input budget with output reserve', () => {
    const policy = createContextPolicy({ contextWindow: 256_000 });
    expect(policy.outputReserve).toBe(32_000);
    expect(policy.inputBudget).toBe(224_000);
    expect(policy.compactThreshold).toBe(Math.floor(224_000 * 0.8));
    expect(policy.toolResultQuota).toBe(Math.floor(224_000 * 0.4));
  });

  it('halves budgets for subagent', () => {
    const main = createContextPolicy({ contextWindow: 200_000 });
    const sub = createContextPolicy({ contextWindow: 200_000, isSubagent: true });
    expect(sub.inputBudget).toBe(Math.floor(main.inputBudget / 2));
    expect(sub.compactThreshold).toBe(Math.floor(main.compactThreshold / 2));
  });
});
