import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolDefinition, ToolHandlerResult } from '../toolGateway';
import { ToolBoundaryError } from './paths';
import { createBuiltinTools } from './index';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-read-tools-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function findTool(name: string): ToolDefinition {
  const tool = createBuiltinTools(root).find((candidate) => candidate.name === name);
  expect(tool, `${name} should be registered`).toBeDefined();
  return tool as ToolDefinition;
}

function runTool(name: string, input: unknown): Promise<ToolHandlerResult> {
  const tool = findTool(name);
  return tool.execute({
    runId: 'run-1',
    toolName: name,
    input,
    signal: new AbortController().signal
  });
}

function git(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function initializeRepository(): Promise<void> {
  await git(['init', '--quiet']);
  await git(['config', 'user.name', 'Kross Test']);
  await git(['config', 'user.email', 'kross@example.com']);
  await writeFile(join(root, 'note.txt'), 'before\n');
  await git(['add', 'note.txt']);
  await git(['commit', '--quiet', '-m', 'initial commit']);
}

describe('additional read-only builtin tools', () => {
  it('List returns a bounded directory tree and hides dotfiles by default', async () => {
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await writeFile(join(root, 'README.md'), 'hello');
    await writeFile(join(root, '.secret'), 'hidden');
    await writeFile(join(root, 'src', 'index.ts'), 'export {};');
    await writeFile(join(root, 'src', 'nested', 'deep.ts'), 'export {};');

    const result = await runTool('List', { path: '.', depth: 2 });

    expect(result.content).toContain('[file] README.md (5 bytes)');
    expect(result.content).toContain('[dir] src/');
    expect(result.content).toContain('[file] src/index.ts (10 bytes)');
    expect(result.content).toContain('[dir] src/nested/');
    expect(result.content).not.toContain('.secret');
    expect(result.content).not.toContain('deep.ts');
    expect(result.summary).toContain('4 entries');
  });

  it('List rejects a start path outside the workspace', async () => {
    await expect(runTool('List', { path: '../outside' })).rejects.toThrow(
      ToolBoundaryError
    );
  });

  it('Stat returns structured filesystem metadata', async () => {
    await writeFile(join(root, 'note.txt'), 'hello');

    const result = await runTool('Stat', { path: 'note.txt' });

    expect(result.content).toContain('"path": "note.txt"');
    expect(result.data).toEqual(
      expect.objectContaining({
        path: 'note.txt',
        type: 'file',
        size: 5
      })
    );
  });

  it('GitStatus reports working-tree changes', async () => {
    await initializeRepository();
    await writeFile(join(root, 'note.txt'), 'after\n');

    const result = await runTool('GitStatus', {});

    expect(result.content).toContain(' M note.txt');
    expect(result.summary).toContain('1 change');
  });

  it('GitDiff returns an optionally path-scoped patch', async () => {
    await initializeRepository();
    await writeFile(join(root, 'note.txt'), 'after\n');
    await writeFile(join(root, 'other.txt'), 'ignored\n');

    const result = await runTool('GitDiff', { path: 'note.txt', context: 1 });

    expect(result.content).toContain('-before');
    expect(result.content).toContain('+after');
    expect(result.content).not.toContain('other.txt');
  });

  it('GitLog returns recent commit summaries', async () => {
    await initializeRepository();

    const result = await runTool('GitLog', { limit: 1 });

    expect(result.content).toMatch(/^[0-9a-f]+ initial commit/m);
    expect(result.summary).toContain('1 commit');
  });

  it('GitLog treats a repository without commits as an empty history', async () => {
    await git(['init', '--quiet']);

    const result = await runTool('GitLog', {});

    expect(result.content).toBe('(no commits)');
    expect(result.summary).toBe('0 commits');
  });
});
