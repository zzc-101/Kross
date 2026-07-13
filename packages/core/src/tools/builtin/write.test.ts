import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './paths';
import { createWriteTool } from './write';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-write-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(input: any) {
  const tool = createWriteTool(root);
  return tool.execute({
    runId: 'r',
    toolName: tool.name,
    input,
    signal: new AbortController().signal
  });
}

describe('Write', () => {
  it('writes file and creates parent dirs', async () => {
    const res = await run({ path: 'sub/dir/a.txt', content: 'hello' });
    expect(res.summary).toContain('created');
    expect(res.summary).toContain('+1');
    expect(res.data).toMatchObject({
      path: 'sub/dir/a.txt',
      created: true,
      linesAdded: 1,
      linesRemoved: 0
    });
    const back = await readFile(join(root, 'sub/dir/a.txt'), 'utf8');
    expect(back).toBe('hello');
  });

  it('reports overwrite line stats', async () => {
    await run({ path: 'a.txt', content: 'a\nb\nc\n' });
    const res = await run({ path: 'a.txt', content: 'a\nx\nc\n' });
    expect(res.summary).toContain('overwrote');
    expect(res.summary).toContain('+1 -1');
    expect(res.data).toMatchObject({
      created: false,
      linesAdded: 1,
      linesRemoved: 1
    });
  });

  it('rejects paths outside workspace', async () => {
    await expect(run({ path: '/tmp/evil.txt', content: 'x' })).rejects.toThrow(
      ToolBoundaryError
    );
  });

  it('rejects writes through symlinked directories outside workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kross-write-outside-'));
    try {
      await symlink(outside, join(root, 'outside-link'));

      await expect(
        run({ path: 'outside-link/evil.txt', content: 'x' })
      ).rejects.toThrow(ToolBoundaryError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
