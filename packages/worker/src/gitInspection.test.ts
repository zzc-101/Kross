import { describe, expect, it } from 'vitest';

import { appendGitPatch } from './gitInspection';

describe('appendGitPatch', () => {
  it('adds unstaged and staged patches to the inspection summary', async () => {
    const result = await appendGitPatch('/repo', 'Diff\nrun: run-1', async (args) => ({
      stdout: args.includes('--cached')
        ? 'diff --git a/b.ts b/b.ts\n+staged'
        : 'diff --git a/a.ts b/a.ts\n-added\n+added',
      stderr: ''
    }));

    expect(result).toContain('--- KROSS PATCH ---');
    expect(result).toContain('# 未暂存变更');
    expect(result).toContain('# 已暂存变更');
    expect(result).toContain('+added');
    expect(result).toContain('+staged');
  });

  it('keeps the summary when git patch collection fails', async () => {
    const result = await appendGitPatch('/repo', 'Diff summary', async () => {
      throw new Error('not a repository');
    });

    expect(result).toContain('Diff summary');
    expect(result).toContain('Git patch 读取失败');
  });
});
