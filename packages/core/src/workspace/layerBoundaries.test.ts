import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const coreSrcDir = dirname(workspaceDir);
const repoRoot = dirname(dirname(dirname(coreSrcDir)));

describe('project instruction layer boundaries', () => {
  it('keeps the workspace loader independent from runtime, context and TUI', () => {
    const source = readFileSync(
      join(workspaceDir, 'projectInstructions.ts'),
      'utf8'
    );

    expect(source).not.toMatch(/from\s+['"][^'"]*runtime/);
    expect(source).not.toMatch(/from\s+['"][^'"]*context\/sessionContext/);
    expect(source).not.toContain('packages/tui');
  });

  it('keeps TUI instruction inspection behind AgentRuntime public APIs', () => {
    const source = readFileSync(
      join(repoRoot, 'packages/tui/src/app/appCommands.ts'),
      'utf8'
    );

    expect(source).toContain('runtime.refreshProjectInstructions()');
    expect(source).not.toContain('loadProjectInstructions');
    expect(source).not.toContain('formatProjectInstructionSource');
    expect(source).not.toMatch(/workspace\/projectInstructions/);
  });
});
