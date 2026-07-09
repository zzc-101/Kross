import { describe, expect, it } from 'vitest';

import { formatLocationLabel } from './HeaderBar';
import { formatCwdLabel } from './WelcomeHome';

describe('formatCwdLabel', () => {
  it('rewrites home directory to ~', () => {
    expect(formatCwdLabel('/Users/zc/MyProject/agent', '/Users/zc')).toBe(
      '~/MyProject/agent'
    );
  });

  it('keeps absolute paths outside home', () => {
    expect(formatCwdLabel('/tmp/work', '/Users/zc')).toBe('/tmp/work');
  });
});

describe('formatLocationLabel', () => {
  it('prefers branch and cwd over projectName', () => {
    expect(
      formatLocationLabel({
        branch: 'main',
        cwdLabel: '~/MyProject/agent',
        projectName: 'local'
      })
    ).toBe('main  ~/MyProject/agent');
  });

  it('falls back to projectName when location is missing', () => {
    expect(formatLocationLabel({ projectName: 'local' })).toBe('local');
  });
});
