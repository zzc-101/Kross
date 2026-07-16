import { describe, expect, it } from 'vitest';

import { formatToolInputPreview } from './formatToolInputPreview';

describe('formatToolInputPreview', () => {
  it('formats Write with path and line count', () => {
    const preview = formatToolInputPreview('Write', {
      path: 'src/a.ts',
      content: 'line1\nline2\n'
    });
    expect(preview).toContain('src/a.ts');
    expect(preview).toContain('2 lines');
    expect(preview).toContain('line1');
  });

  it('formats Edit with path and old/new snippets', () => {
    const preview = formatToolInputPreview('Edit', {
      path: 'src/a.ts',
      old_string: 'const x = 1',
      new_string: 'const x = 2'
    });
    expect(preview).toContain('src/a.ts');
    expect(preview).toContain('- const x = 1');
    expect(preview).toContain('+ const x = 2');
  });

  it('formats Bash as shell command', () => {
    expect(formatToolInputPreview('Bash', { command: 'npm test' })).toBe(
      '$ npm test'
    );
  });

  it('formats ProcessStart without exposing argument values', () => {
    const preview = formatToolInputPreview('ProcessStart', {
      command: 'curl --header="Bearer secret" https://example.test/private'
    });
    expect(preview).toContain('$ curl --header');
    expect(preview).toMatch(/\d+ args?/);
    expect(preview).not.toContain('Bearer secret');
    expect(preview).not.toContain('/private');
  });
});
