import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './paths';
import {
  compileGlob,
  compileGlobMatcher,
  createGlobTool,
  expandGlobBraces,
  normalizeGlobPattern
} from './glob';

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

describe('expandGlobBraces', () => {
  it('expands extension braces used by models', () => {
    expect(expandGlobBraces('**/*.{ts,js,md}')).toEqual([
      '**/*.ts',
      '**/*.js',
      '**/*.md'
    ]);
  });
});

describe('compileGlobMatcher', () => {
  it('matches brace patterns that previously returned 0 hits', () => {
    const match = compileGlobMatcher('**/*.{json,md,ts}');
    expect(match('package.json')).toBe(true);
    expect(match('README.md')).toBe(true);
    expect(match('src/a.ts')).toBe(true);
    expect(match('src/a.py')).toBe(false);
  });
});

describe('normalizeGlobPattern', () => {
  it('prepends **/ for bare filenames and globs', () => {
    expect(normalizeGlobPattern('test.txt')).toBe('**/test.txt');
    expect(normalizeGlobPattern('*.ts')).toBe('**/*.ts');
  });

  it('leaves path patterns and explicit ** alone', () => {
    expect(normalizeGlobPattern('src/**/*.ts')).toBe('src/**/*.ts');
    expect(normalizeGlobPattern('**/a.ts')).toBe('**/a.ts');
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

  it('supports brace extension patterns like models often emit', async () => {
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(root, 'README.md'), '# hi');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), '');
    await writeFile(join(root, 'src', 'b.py'), '');
    const res = await run({
      pattern: '**/*.{json,md,toml,yaml,yml,ts,js,py,go,rs,java}'
    });
    expect(res.summary).not.toContain('matched 0');
    expect(res.content).toContain('package.json');
    expect(res.content).toContain('README.md');
    expect(res.content).toContain('src/a.ts');
    expect(res.content).toContain('src/b.py');
  });

  it('finds bare filename at workspace root even with huge node_modules', async () => {
    await writeFile(join(root, 'test.txt'), 'hello');
    // 模拟 node_modules 先被 readdir 扫到、深度巨大的情况
    const nm = join(root, 'node_modules', 'pkg');
    await mkdir(nm, { recursive: true });
    for (let i = 0; i < 50; i += 1) {
      await writeFile(join(nm, `f-${i}.js`), '');
    }

    const res = await run({ pattern: 'test.txt' });
    expect(res.content).toContain('test.txt');
    expect(res.summary).toContain('matched 1');
  });

  it('matches nested files with bare *.ext pattern', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), '');
    const res = await run({ pattern: '*.ts' });
    expect(res.content).toContain('src/a.ts');
  });

  it('skips node_modules contents by default', async () => {
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'x', 'hidden.ts'), '');
    await writeFile(join(root, 'keep.ts'), '');
    const res = await run({ pattern: '**/*.ts' });
    expect(res.content).toContain('keep.ts');
    expect(res.content).not.toContain('hidden.ts');
  });

  it('rejects path outside workspace', async () => {
    await expect(run({ pattern: '*', path: '/etc' })).rejects.toThrow(
      ToolBoundaryError
    );
  });
});
