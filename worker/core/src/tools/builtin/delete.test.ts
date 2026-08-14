import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './paths';
import { createDeleteTool } from './delete';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-del-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(input: { path: string; recursive?: boolean }) {
  const tool = createDeleteTool(root);
  return tool.execute({
    runId: 'r',
    toolName: tool.name,
    input,
    signal: new AbortController().signal
  });
}

describe('Delete', () => {
  it('deletes a file', async () => {
    await writeFile(join(root, 'a.txt'), 'x');
    const res = await run({ path: 'a.txt' });
    expect(res.summary).toContain('deleted');
    await expect(readFile(join(root, 'a.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('refuses non-empty directory without recursive', async () => {
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'dir', 'f.txt'), 'x');
    const res = await run({ path: 'dir' });
    expect(res.summary).toContain('refused');
    expect(await readFile(join(root, 'dir', 'f.txt'), 'utf8')).toBe('x');
  });

  it('deletes directory with recursive', async () => {
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'dir', 'f.txt'), 'x');
    const res = await run({ path: 'dir', recursive: true });
    expect(res.summary).toContain('deleted');
    await expect(readFile(join(root, 'dir', 'f.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects paths outside workspace', async () => {
    await expect(run({ path: '/tmp/evil' })).rejects.toThrow(ToolBoundaryError);
  });
});
