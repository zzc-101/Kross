import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const coreSrcDir = dirname(workspaceDir);

describe('project instruction layer boundaries', () => {
  it('keeps the workspace loader independent from runtime, context and product hosts', () => {
    const source = readFileSync(
      join(workspaceDir, 'projectInstructions.ts'),
      'utf8'
    );

    expect(source).not.toMatch(/from\s+['"][^'"]*runtime/);
    expect(source).not.toMatch(/from\s+['"][^'"]*context\/sessionContext/);
    expect(source).not.toContain('apps/tui');
  });

});
