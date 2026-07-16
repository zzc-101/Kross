import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MutationService } from '../../mutations/mutationService';
import { createApplyPatchTool } from './applyPatch';
import { ToolGateway } from '../toolGateway';

let temp = '';
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = '';
});

function setup() {
  temp = mkdtempSync(join(tmpdir(), 'kross-apply-patch-'));
  const workspace = join(temp, 'workspace');
  mkdirSync(workspace);
  const mutations = new MutationService(workspace, join(temp, 'home'));
  const tool = createApplyPatchTool(workspace, mutations);
  return { workspace, mutations, tool };
}

describe('ApplyPatch', () => {
  it('atomically adds, updates and deletes files and can undo the transaction', async () => {
    const { workspace, mutations, tool } = setup();
    writeFileSync(join(workspace, 'update.txt'), 'hello\nworld\n');
    writeFileSync(join(workspace, 'delete.txt'), 'remove me');

    const result = await tool.execute({
      runId: 'run-patch',
      toolName: 'ApplyPatch',
      signal: new AbortController().signal,
      input: {
        patch: [
          '*** Begin Patch',
          '*** Add File: added.txt',
          '+new file',
          '*** Update File: update.txt',
          '@@',
          ' hello',
          '-world',
          '+kross',
          '*** Delete File: delete.txt',
          '*** End Patch'
        ].join('\n')
      }
    });

    expect(result.data).toMatchObject({ added: 1, updated: 1, deleted: 1 });
    expect(readFileSync(join(workspace, 'added.txt'), 'utf8')).toBe('new file\n');
    expect(readFileSync(join(workspace, 'update.txt'), 'utf8')).toBe('hello\nkross\n');
    expect(() => readFileSync(join(workspace, 'delete.txt'))).toThrow();

    mutations.undo('run-patch');
    expect(() => readFileSync(join(workspace, 'added.txt'))).toThrow();
    expect(readFileSync(join(workspace, 'update.txt'), 'utf8')).toBe('hello\nworld\n');
    expect(readFileSync(join(workspace, 'delete.txt'), 'utf8')).toBe('remove me');
  });

  it('writes nothing when any planned hunk is invalid', async () => {
    const { workspace, mutations, tool } = setup();
    writeFileSync(join(workspace, 'a.txt'), 'original');

    await expect(
      tool.execute({
        runId: 'run-invalid',
        toolName: 'ApplyPatch',
        signal: new AbortController().signal,
        input: {
          patch: [
            '*** Begin Patch',
            '*** Add File: added.txt',
            '+would be added',
            '*** Update File: a.txt',
            '@@',
            '-missing',
            '+replacement',
            '*** End Patch'
          ].join('\n')
        }
      })
    ).rejects.toThrow(/does not match/);

    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('original');
    expect(() => readFileSync(join(workspace, 'added.txt'))).toThrow();
    expect(mutations.listActive()).toEqual([]);
  });

  it('rejects symlink escape and non-text or oversized patch input', async () => {
    const { workspace, mutations, tool } = setup();
    const outside = join(temp, 'outside.txt');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(workspace, 'link.txt'));
    await expect(
      tool.execute({
        runId: 'escape',
        toolName: 'ApplyPatch',
        signal: new AbortController().signal,
        input: {
          patch: [
            '*** Begin Patch',
            '*** Update File: link.txt',
            '@@',
            '-outside',
            '+changed',
            '*** End Patch'
          ].join('\n')
        }
      })
    ).rejects.toThrow(/workspace/i);

    const gateway = new ToolGateway({ approvalPolicy: () => ({ action: 'allow' }) });
    gateway.register(createApplyPatchTool(workspace, mutations));
    await expect(
      gateway.call({ runId: 'nul', name: 'ApplyPatch', input: { patch: '\0' } })
    ).rejects.toThrow();
    await expect(
      gateway.call({
        runId: 'large',
        name: 'ApplyPatch',
        input: { patch: 'x'.repeat(513 * 1024) }
      })
    ).rejects.toThrow();
  });
});
