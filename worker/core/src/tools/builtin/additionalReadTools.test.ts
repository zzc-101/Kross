import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolDefinition, ToolHandlerResult } from '../toolGateway';
import { ToolBoundaryError } from './paths';
import { createSaasTools } from './index';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-read-tools-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runTool(name: string, input: unknown): Promise<ToolHandlerResult> {
  const tool = createSaasTools(root).find((candidate) => candidate.name === name);
  expect(tool, `${name} should be registered`).toBeDefined();
  return (tool as ToolDefinition).execute({
    runId: 'run-1',
    toolName: name,
    input,
    signal: new AbortController().signal
  });
}

describe('additional read-only builtin tools', () => {
  it('List returns a bounded directory tree and hides dotfiles by default', async () => {
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await writeFile(join(root, 'README.md'), 'hello');
    await writeFile(join(root, '.secret'), 'hidden');
    await writeFile(join(root, 'src', 'index.ts'), 'export {};');
    await writeFile(join(root, 'src', 'nested', 'deep.ts'), 'export {};');

    const result = await runTool('List', { path: '.', depth: 2 });

    expect(result.content).toContain('[file] README.md (5 bytes)');
    expect(result.content).toContain('[dir] src/');
    expect(result.content).toContain('[file] src/index.ts (10 bytes)');
    expect(result.content).toContain('[dir] src/nested/');
    expect(result.content).not.toContain('.secret');
    expect(result.content).not.toContain('deep.ts');
    expect(result.summary).toContain('4 entries');
  });

  it('List rejects a start path outside the workspace', async () => {
    await expect(runTool('List', { path: '../outside' })).rejects.toThrow(
      ToolBoundaryError
    );
  });

  it('Stat returns structured filesystem metadata', async () => {
    await writeFile(join(root, 'note.txt'), 'hello');

    const result = await runTool('Stat', { path: 'note.txt' });

    expect(result.content).toContain('"path": "note.txt"');
    expect(result.data).toEqual(
      expect.objectContaining({ path: 'note.txt', type: 'file', size: 5 })
    );
  });
});
