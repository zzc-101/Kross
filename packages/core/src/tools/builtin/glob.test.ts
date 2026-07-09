import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './paths';
import { compileGlob, createGlobTool } from './glob';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-glob-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(input: any) {
  const tool = createGlobTool(root);
  return tool.execute({
    runId: 'r',
    toolName: tool.name,
    input,
    signal: new AbortController().signal
  });
}

describe('compileGlob', () => {
  it('matches ** and *', () => {
    expect(compileGlob('src/**/*.ts').test('src/index.ts')).toBe(true);
    expect(compileGlob('src/**/*.ts').test('src/a/b.ts')).toBe(true);
    expect(compileGlob('src/**/*.ts').test('a.ts')).toBe(false);
    expect(compileGlob('*.md').test('README.md')).toBe(true);
    expect(compileGlob('*.md').test('a/b.md')).toBe(false);
  });
});

describe('Glob', () => {
  it('lists matching files relative to workspace', async () => {
    await writeFile(join(root, 'a.ts'), '');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'b.ts'), '');
    await writeFile(join(root, 'src', 'c.md'), '');
    const res = await run({ pattern: '**/*.ts' });
    expect(res.content).toContain('a.ts');
    expect(res.content).toContain('src/b.ts');
    expect(res.content).not.toContain('src/c.md');
  });

  it('rejects path outside workspace', async () => {
    await expect(run({ pattern: '*', path: '/etc' })).rejects.toThrow(
      ToolBoundaryError
    );
  });
});
