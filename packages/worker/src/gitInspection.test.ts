import { describe, expect, it } from 'vitest';

import { inspectGitDiff } from './gitInspection';

describe('inspectGitDiff', () => {
  it('returns distinct unstaged and staged patch sections', async () => {
    const result = await inspectGitDiff('/repo', 'Diff\nrun: run-1', async (args) => ({
      stdout: args.includes('--cached')
        ? 'diff --git a/b.ts b/b.ts\n+staged'
        : 'diff --git a/a.ts b/a.ts\n-added\n+added',
      stderr: ''
    }));

    expect(result.summary).toContain('run-1');
    expect(result.patches).toEqual([
      expect.objectContaining({ staged: false, patch: expect.stringContaining('+added') }),
      expect.objectContaining({ staged: true, patch: expect.stringContaining('+staged') })
    ]);
  });

  it('keeps the summary when git patch collection fails', async () => {
    const result = await inspectGitDiff('/repo', 'Diff summary', async () => {
      throw new Error('not a repository');
    });

    expect(result.summary).toContain('Diff summary');
    expect(result.summary).toContain('Git patch 读取失败');
    expect(result.patches).toEqual([]);
  });
});
