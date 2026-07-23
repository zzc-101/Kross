import { describe, expect, it } from 'vitest';

import { validateGitRef } from './actionDialog';

describe('validateGitRef', () => {
  it('accepts common branch names', () => {
    expect(validateGitRef('feature/p1-ui')).toBeUndefined();
    expect(validateGitRef('release_2026.07')).toBeUndefined();
  });

  it('rejects empty and option-like values', () => {
    expect(validateGitRef('')).toContain('不能为空');
    expect(validateGitRef('--force')).toContain('只能包含');
    expect(validateGitRef('feature name')).toContain('只能包含');
  });
});
