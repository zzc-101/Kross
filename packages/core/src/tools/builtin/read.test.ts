import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './paths';
import { createReadTool } from './read';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-read-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(input: any) {
  const tool = createReadTool(root);
  return tool.execute({
    runId: 'r',
    toolName: tool.name,
    input,
    signal: new AbortController().signal
  });
}

describe('Read', () => {
  it('reads file content', async () => {
    await writeFile(join(root, 'a.txt'), 'line1\nline2\nline3');
    const res = await run({ path: 'a.txt' });
    expect(res.content).toBe('line1\nline2\nline3');
    expect(res.summary).toContain('3 lines');
  });

  it('supports offset/limit', async () => {
    await writeFile(join(root, 'a.txt'), '1\n2\n3\n4');
    const res = await run({ path: 'a.txt', offset: 1, limit: 2 });
    expect(res.content).toBe('2\n3');
  });

  it('supports offset/limit for large files', async () => {
    const lines = Array.from({ length: 260_000 }, (_, index) => `line-${index}`);
    await writeFile(join(root, 'large.txt'), lines.join('\n'));

    const res = await run({ path: 'large.txt', offset: 100, limit: 3 });

    expect(res.content).toBe('line-100\nline-101\nline-102');
    expect(res.summary).toContain('3 lines');
  });

  it('rejects paths outside workspace', async () => {
    await expect(run({ path: '../../etc/passwd' })).rejects.toThrow(
      ToolBoundaryError
    );
  });

  it('rejects symlinks that resolve outside workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kross-read-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(join(outside, 'secret.txt'), join(root, 'secret-link.txt'));

      await expect(run({ path: 'secret-link.txt' })).rejects.toThrow(
        ToolBoundaryError
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
