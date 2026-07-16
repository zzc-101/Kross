import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MutationService } from '../../mutations/mutationService';
import { createDeleteTool } from './delete';
import { createEditTool } from './edit';
import { createMoveTool } from './move';
import { createWriteTool } from './write';

let temp = '';
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = '';
});

function context<T>(runId: string, toolName: string, input: T) {
  return {
    runId,
    toolName,
    input,
    signal: new AbortController().signal
  };
}

describe('journaled builtin mutation tools', () => {
  it('can undo Write, Edit, Delete and Move including directory contents', async () => {
    temp = mkdtempSync(join(tmpdir(), 'kross-mutation-tools-'));
    const workspace = join(temp, 'workspace');
    mkdirSync(workspace);
    const mutations = new MutationService(workspace, join(temp, 'home'));

    await createWriteTool(workspace, mutations).execute(
      context('run-write', 'Write', { path: 'created.txt', content: 'created' })
    );
    mutations.undo('run-write');
    expect(existsSync(join(workspace, 'created.txt'))).toBe(false);

    writeFileSync(join(workspace, 'edit.txt'), 'before');
    await createEditTool(workspace, mutations).execute(
      context('run-edit', 'Edit', {
        path: 'edit.txt',
        old_string: 'before',
        new_string: 'after'
      })
    );
    mutations.undo('run-edit');
    expect(readFileSync(join(workspace, 'edit.txt'), 'utf8')).toBe('before');

    mkdirSync(join(workspace, 'deleted'));
    writeFileSync(join(workspace, 'deleted', 'nested.txt'), 'nested');
    await createDeleteTool(workspace, mutations).execute(
      context('run-delete', 'Delete', { path: 'deleted', recursive: true })
    );
    mutations.undo('run-delete');
    expect(readFileSync(join(workspace, 'deleted', 'nested.txt'), 'utf8')).toBe('nested');

    writeFileSync(join(workspace, 'from.txt'), 'move');
    await createMoveTool(workspace, mutations).execute(
      context('run-move', 'Move', { from: 'from.txt', to: 'to.txt' })
    );
    mutations.undo('run-move');
    expect(readFileSync(join(workspace, 'from.txt'), 'utf8')).toBe('move');
    expect(existsSync(join(workspace, 'to.txt'))).toBe(false);
  });
});
