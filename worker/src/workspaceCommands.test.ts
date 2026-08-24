import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkspaceCommand } from './workspaceCommands';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-workspace-command-'));
  outside = await mkdtemp(join(tmpdir(), 'kross-workspace-outside-'));
});

afterEach(async () => {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]);
});

function command(name: string, payload: Record<string, unknown>) {
  return handleWorkspaceCommand(root, { commandId: 'command-1', name, payload });
}

describe('workspace commands', () => {
  it('reads and writes regular workspace files', async () => {
    await command('workspace.write', { path: 'notes/item.txt', content: 'safe' });

    expect(await readFile(join(root, 'notes', 'item.txt'), 'utf8')).toBe('safe');
    await expect(command('workspace.read', { path: 'notes/item.txt' })).resolves.toMatchObject({
      content: 'safe'
    });
  });

  it('rejects reads and writes through symlinks escaping the workspace', async () => {
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await mkdir(join(root, 'links'));
    await symlink(outside, join(root, 'links', 'escape'));

    await expect(command('workspace.read', {
      path: 'links/escape/secret.txt'
    })).rejects.toThrow('workspace');
    await expect(command('workspace.write', {
      path: 'links/escape/new.txt',
      content: 'blocked'
    })).rejects.toThrow('workspace');
  });
});
