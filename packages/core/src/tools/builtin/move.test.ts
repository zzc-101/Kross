import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './paths';
import { createMoveTool } from './move';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-mv-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(input: { from: string; to: string }) {
  const tool = createMoveTool(root);
  return tool.execute({
    runId: 'r',
    toolName: tool.name,
    input,
    signal: new AbortController().signal
  });
}

describe('Move', () => {
  it('renames a file and creates parent dirs', async () => {
    await writeFile(join(root, 'a.txt'), 'hello');
    const res = await run({ from: 'a.txt', to: 'sub/b.txt' });
    expect(res.summary).toContain('moved');
    expect(await readFile(join(root, 'sub', 'b.txt'), 'utf8')).toBe('hello');
    await expect(readFile(join(root, 'a.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('moves a directory', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'x.ts'), 'x');
    await run({ from: 'src', to: 'lib' });
    expect(await readFile(join(root, 'lib', 'x.ts'), 'utf8')).toBe('x');
  });

  it('rejects outside workspace', async () => {
    await writeFile(join(root, 'a.txt'), 'x');
    await expect(run({ from: 'a.txt', to: '/tmp/evil' })).rejects.toThrow(
      ToolBoundaryError
    );
  });
});
