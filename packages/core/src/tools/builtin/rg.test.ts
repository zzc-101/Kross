import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './paths';
import {
  buildRgArgs,
  createRgTool,
  type RgCommandOutput,
  type RgInput
} from './rg';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-rg-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeRunner(output: Partial<RgCommandOutput> = {}) {
  const calls: Array<{ binary: string; args: string[]; cwd: string }> = [];
  const runCommand = async (
    binary: string,
    args: string[],
    cwd: string
  ): Promise<RgCommandOutput> => {
    calls.push({ binary, args, cwd });
    return {
      stdout: output.stdout ?? '',
      stderr: output.stderr ?? '',
      code: output.code ?? 0,
      error: output.error
    };
  };
  return { runCommand, calls };
}

async function run(
  input: RgInput,
  runCommand: (
    binary: string,
    args: string[],
    cwd: string,
    signal: AbortSignal,
    timeoutMs: number
  ) => Promise<RgCommandOutput>
) {
  const tool = createRgTool(root, { runCommand });
  return tool.execute({
    runId: 'r',
    toolName: tool.name,
    input,
    signal: new AbortController().signal
  });
}

describe('buildRgArgs', () => {
  it('builds content-search argv with -e pattern', () => {
    expect(buildRgArgs({ pattern: 'foo' }, '/ws')).toEqual([
      '--color=never',
      '--line-number',
      '--no-heading',
      '--with-filename',
      '-e',
      'foo',
      '/ws'
    ]);
  });

  it('builds files-only argv', () => {
    expect(
      buildRgArgs({ filesOnly: true, glob: '*.ts' }, '/ws/src')
    ).toEqual(['--color=never', '-g', '*.ts', '--files', '/ws/src']);
  });

  it('supports ignoreCase, fixedString, context and type', () => {
    const args = buildRgArgs(
      {
        pattern: 'a-b',
        ignoreCase: true,
        fixedString: true,
        type: 'ts',
        contextBefore: 1,
        contextAfter: 2,
        glob: ['*.ts', '!**/dist/**']
      },
      '/ws'
    );
    expect(args).toContain('-i');
    expect(args).toContain('-F');
    expect(args).toContain('-t');
    expect(args).toContain('ts');
    expect(args).toEqual(
      expect.arrayContaining(['-B', '1', '-A', '2', '-g', '*.ts', '-g', '!**/dist/**'])
    );
  });
});

describe('Rg', () => {
  it('returns matching lines from rg stdout', async () => {
    const { runCommand, calls } = fakeRunner({
      stdout: 'a.ts:1:hello\na.ts:3:hello world\n',
      code: 0
    });
    const res = await run({ pattern: 'hello' }, runCommand);
    expect(res.content).toContain('a.ts:1:hello');
    expect(res.content).toContain('a.ts:3:hello world');
    expect(res.summary).toContain('matches=2');
    expect(calls[0]?.args).toContain('-e');
    expect(calls[0]?.args).toContain('hello');
  });

  it('treats exit code 1 as no matches', async () => {
    const { runCommand } = fakeRunner({ stdout: '', code: 1 });
    const res = await run({ pattern: 'zzz' }, runCommand);
    expect(res.content).toBe('(无匹配)');
    expect(res.summary).toContain('matches=0');
  });

  it('lists files in filesOnly mode', async () => {
    const { runCommand, calls } = fakeRunner({
      stdout: 'src/a.ts\nsrc/b.ts\n',
      code: 0
    });
    const res = await run({ filesOnly: true, glob: '*.ts' }, runCommand);
    expect(res.content).toContain('src/a.ts');
    expect(res.summary).toContain('files=2');
    expect(calls[0]?.args).toContain('--files');
  });

  it('truncates at headLimit', async () => {
    const stdout = Array.from({ length: 10 }, (_, i) => `f.ts:${i + 1}:x`).join(
      '\n'
    );
    const { runCommand } = fakeRunner({ stdout, code: 0 });
    const res = await run({ pattern: 'x', headLimit: 3 }, runCommand);
    expect(res.content.split('\n').filter((l) => l.includes(':x'))).toHaveLength(
      3
    );
    expect(res.content).toContain('已截断');
  });

  it('reports missing binary clearly', async () => {
    const { runCommand } = fakeRunner({
      code: null,
      error: Object.assign(new Error('not found'), { code: 'ENOENT' })
    });
    const res = await run({ pattern: 'x' }, runCommand);
    expect(res.content).toContain('未找到 rg');
    expect(res.summary).toBe('rg not found');
  });

  it('rejects path outside workspace before spawning', async () => {
    const { runCommand, calls } = fakeRunner({ code: 0 });
    await expect(run({ pattern: 'x', path: '/etc' }, runCommand)).rejects.toThrow(
      ToolBoundaryError
    );
    expect(calls).toHaveLength(0);
  });

  it('requires pattern unless filesOnly', async () => {
    const tool = createRgTool(root, {
      runCommand: async () => ({ stdout: '', stderr: '', code: 0 })
    });
    await expect(
      tool.inputSchema.parseAsync({})
    ).rejects.toThrow(/pattern/i);
    await expect(
      tool.inputSchema.parseAsync({ filesOnly: true })
    ).resolves.toMatchObject({ filesOnly: true });
  });

  it('uses workspace-relative path as search root', async () => {
    await mkdir(join(root, 'pkg'), { recursive: true });
    await writeFile(join(root, 'pkg', 'n.txt'), 'n');
    const { runCommand, calls } = fakeRunner({ stdout: '', code: 1 });
    await run({ pattern: 'n', path: 'pkg' }, runCommand);
    const searchPath = calls[0]?.args.at(-1);
    expect(searchPath).toBe(join(root, 'pkg'));
  });
});
