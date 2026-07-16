import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));

describe('layer boundaries', () => {
  it('task.ts does not import subagentRunner implementation', () => {
    const source = readFileSync(join(dir, 'task.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"][^'"]*subagentRunner['"]/);
    expect(source).not.toMatch(/subagentRunner/);
  });
});
