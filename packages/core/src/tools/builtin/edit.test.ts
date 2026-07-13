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
    expect(res.summary).toMatch(/\+1\s+-1|±0|\+1|-1/);
    expect(res.data).toMatchObject({
      path: 'a.txt',
      occurrences: 1,
      linesAdded: 1,
      linesRemoved: 1,
      mutated: true
    });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('foo baz foo');
  });

  it('reports multi-line hunk stats', async () => {
    await writeFile(join(root, 'b.txt'), 'keep\nold1\nold2\nkeep\n');
    const res = await run({
      path: 'b.txt',
      old_string: 'old1\nold2',
      new_string: 'new1\nnew2\nnew3'
    });
    expect(res.summary).toContain('+3 -2');
    expect(res.data).toMatchObject({
      linesAdded: 3,
      linesRemoved: 2,
      mutated: true
    });
    const preview = (res.data as { diffPreview?: { lines: Array<{ op: string; text: string }> } })
      .diffPreview;
    expect(preview?.lines.some((l) => l.op === 'del' && l.text.includes('old1'))).toBe(
      true
    );
    expect(preview?.lines.some((l) => l.op === 'add' && l.text.includes('new3'))).toBe(
      true
    );
    // 带文件上下文：keep 应作为 ctx 出现
    expect(preview?.lines.some((l) => l.op === 'ctx' && l.text === 'keep')).toBe(
      true
    );
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

  it('applies multiple edits in one call', async () => {
    await writeFile(join(root, 'm.txt'), 'aaa\nbbb\nccc\n');
    const res = await run({
      path: 'm.txt',
      edits: [
        { old_string: 'aaa', new_string: 'AAA' },
        { old_string: 'ccc', new_string: 'CCC' }
      ]
    });
    expect(res.summary).toContain('replaced 2');
    expect(res.summary).toContain('2 edits');
    expect(await readFile(join(root, 'm.txt'), 'utf8')).toBe('AAA\nbbb\nCCC\n');
  });

  it('returns nearby hint when no match', async () => {
    await writeFile(join(root, 'h.txt'), 'hello world\nfoo bar\n');
    const res = await run({
      path: 'h.txt',
      old_string: 'helloooo',
      new_string: 'hi'
    });
    expect(res.summary).toBe('no match');
    expect(res.content).toMatch(/附近内容|文件开头/);
  });
});
