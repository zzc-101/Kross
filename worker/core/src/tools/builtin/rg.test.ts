import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './paths';
import {
  buildRgArgs,
  createRgTool,
  resolveRgBinary,
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

describe('resolveRgBinary', () => {
  it('honors explicit override', () => {
    expect(resolveRgBinary('/custom/rg')).toBe('/custom/rg');
  });

  it('prefers the npm-bundled @vscode/ripgrep binary when available', () => {
    const path = resolveRgBinary();
    // 有平台包时为绝对路径；缺失时退回 'rg'
    expect(path === 'rg' || path.includes('ripgrep') || path.endsWith('/rg') || path.endsWith('\\rg.exe')).toBe(
      true
    );
    // 本 monorepo 安装了 @vscode/ripgrep，应解析到真实文件
    if (path !== 'rg') {
      expect(existsSync(path)).toBe(true);
    }
  });
});

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
    expect(res.content).toContain('无法启动 rg');
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

  it('runs a real content search with the bundled rg binary', async () => {
    const binary = resolveRgBinary();
    if (binary === 'rg') {
      // 无内置二进制时跳过（CI 极少见；本机 monorepo 应有）
      return;
    }
    await writeFile(join(root, 'note.ts'), 'export const marker = 42;\n');
    const tool = createRgTool(root);
    const res = await tool.execute({
      runId: 'r',
      toolName: tool.name,
      input: { pattern: 'marker', glob: '*.ts' },
      signal: new AbortController().signal
    });
    expect(res.content).toMatch(/note\.ts:\d+:.*marker/);
    expect(res.summary).toMatch(/matches=/);
  });
});
