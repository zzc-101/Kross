import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './paths';
import { createEditTool } from './edit';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-edit-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(input: any) {
  const tool = createEditTool(root);
  return tool.execute({
    runId: 'r',
    toolName: tool.name,
    input,
    signal: new AbortController().signal
  });
}

describe('Edit', () => {
  it('replaces unique match', async () => {
    await writeFile(join(root, 'a.txt'), 'foo bar foo');
    const res = await run({ path: 'a.txt', old_string: 'bar', new_string: 'baz' });
    expect(res.summary).toContain('replaced 1');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('foo baz foo');
  });

  it('rejects ambiguous match without replace_all', async () => {
    await writeFile(join(root, 'a.txt'), 'foo foo');
    const res = await run({ path: 'a.txt', old_string: 'foo', new_string: 'bar' });
    expect(res.summary).toContain('ambiguous');
  });

  it('replaces all when replace_all is true', async () => {
    await writeFile(join(root, 'a.txt'), 'foo foo');
    const res = await run({
      path: 'a.txt',
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true
    });
    expect(res.summary).toContain('replaced 2');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('bar bar');
  });

  it('rejects paths outside workspace', async () => {
    await expect(
      run({ path: '/tmp/a.txt', old_string: 'x', new_string: 'y' })
    ).rejects.toThrow(ToolBoundaryError);
  });
});
