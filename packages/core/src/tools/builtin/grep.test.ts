import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './paths';
import { createGrepTool } from './grep';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-grep-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(input: any) {
  const tool = createGrepTool(root);
  return tool.execute({
    runId: 'r',
    toolName: tool.name,
    input,
    signal: new AbortController().signal
  });
}

describe('Grep', () => {
  it('finds matching lines with file:line:', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\nbeta\ngamma');
    const res = await run({ pattern: 'beta' });
    expect(res.content).toContain('a.txt:2:beta');
    expect(res.content).not.toContain('a.txt:1:alpha');
    expect(res.content).not.toContain('a.txt:3:gamma');
  });

  it('respects include filter', async () => {
    await writeFile(join(root, 'a.ts'), 'secret');
    await writeFile(join(root, 'a.md'), 'secret');
    const res = await run({ pattern: 'secret', include: '*.ts' });
    expect(res.content).toContain('a.ts:1:secret');
    expect(res.content).not.toContain('a.md');
  });

  it('rejects path outside workspace', async () => {
    await expect(run({ pattern: 'x', path: '/etc' })).rejects.toThrow(
      ToolBoundaryError
    );
  });
});
