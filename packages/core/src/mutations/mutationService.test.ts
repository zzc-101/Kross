import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MutationConflictError, MutationService } from './mutationService';

let temp = '';
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = '';
});

function setup() {
  temp = mkdtempSync(join(tmpdir(), 'kross-mutations-'));
  const workspace = join(temp, 'workspace');
  const krossHome = join(temp, 'home');
  mkdirSync(workspace);
  return { workspace, krossHome };
}

describe('MutationService', () => {
  it('records and undoes a file mutation', async () => {
    const { workspace, krossHome } = setup();
    writeFileSync(join(workspace, 'a.txt'), 'before');
    const service = new MutationService(workspace, krossHome);

    await service.record({
      runId: 'run-1',
      toolName: 'Write',
      paths: ['a.txt'],
      action: async () => writeFileSync(join(workspace, 'a.txt'), 'after')
    });

    expect(service.listActive()).toHaveLength(1);
    expect(service.undo('run-1').files).toEqual(['a.txt']);
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('before');
  });

  it('refuses undo after a conflicting external edit', async () => {
    const { workspace, krossHome } = setup();
    writeFileSync(join(workspace, 'a.txt'), 'before');
    const service = new MutationService(workspace, krossHome);
    await service.record({
      runId: 'run-1',
      toolName: 'Edit',
      paths: ['a.txt'],
      action: async () => writeFileSync(join(workspace, 'a.txt'), 'after')
    });
    writeFileSync(join(workspace, 'a.txt'), 'external');

    expect(() => service.undo()).toThrow(MutationConflictError);
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('external');
  });

  it('undoes repeated writes to the same path within one run', async () => {
    const { workspace, krossHome } = setup();
    writeFileSync(join(workspace, 'a.txt'), 'before');
    const service = new MutationService(workspace, krossHome);

    await service.record({
      runId: 'run-repeated',
      toolName: 'Edit',
      paths: ['a.txt'],
      action: async () => writeFileSync(join(workspace, 'a.txt'), 'first')
    });
    await service.record({
      runId: 'run-repeated',
      toolName: 'Edit',
      paths: ['a.txt'],
      action: async () => writeFileSync(join(workspace, 'a.txt'), 'second')
    });
    const transactionIds = service.listActive().map((item) => item.transactionId);

    const result = service.undo('run-repeated');

    expect(result.transactions).toEqual([...transactionIds].reverse());
    expect(result.files).toEqual(['a.txt']);
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('before');
  });

  it('composes overlapping parent and child post snapshots before undo', async () => {
    const { workspace, krossHome } = setup();
    mkdirSync(join(workspace, 'src'));
    mkdirSync(join(workspace, 'src', 'a'));
    writeFileSync(join(workspace, 'src', 'a', 'nested.txt'), 'before');
    // This sibling intentionally sorts before "a/" by raw full-path order.
    // It guards the snapshot's directory-walk ordering when roots are composed.
    writeFileSync(join(workspace, 'src', 'a.txt'), 'unchanged');
    const service = new MutationService(workspace, krossHome);

    await service.record({
      runId: 'run-overlap',
      toolName: 'Edit',
      paths: ['src'],
      action: async () => writeFileSync(join(workspace, 'src', 'a', 'nested.txt'), 'first')
    });
    await service.record({
      runId: 'run-overlap',
      toolName: 'Edit',
      paths: ['src/a/nested.txt'],
      action: async () => writeFileSync(join(workspace, 'src', 'a', 'nested.txt'), 'second')
    });

    expect(() => service.assertCanUndo('run-overlap')).not.toThrow();
    service.undo('run-overlap');

    expect(readFileSync(join(workspace, 'src', 'a', 'nested.txt'), 'utf8')).toBe('before');
    expect(readFileSync(join(workspace, 'src', 'a.txt'), 'utf8')).toBe('unchanged');
  });

  it('still detects an external edit under an earlier overlapping parent root', async () => {
    const { workspace, krossHome } = setup();
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'a.txt'), 'before');
    writeFileSync(join(workspace, 'src', 'sibling.txt'), 'unchanged');
    const service = new MutationService(workspace, krossHome);

    await service.record({
      runId: 'run-overlap',
      toolName: 'Edit',
      paths: ['src'],
      action: async () => writeFileSync(join(workspace, 'src', 'a.txt'), 'first')
    });
    await service.record({
      runId: 'run-overlap',
      toolName: 'Edit',
      paths: ['src/a.txt'],
      action: async () => writeFileSync(join(workspace, 'src', 'a.txt'), 'second')
    });
    writeFileSync(join(workspace, 'src', 'sibling.txt'), 'external');

    expect(() => service.undo('run-overlap')).toThrow(MutationConflictError);
    expect(readFileSync(join(workspace, 'src', 'a.txt'), 'utf8')).toBe('second');
    expect(readFileSync(join(workspace, 'src', 'sibling.txt'), 'utf8')).toBe('external');
  });

  it('rolls back the workspace when the mutation action fails', async () => {
    const { workspace, krossHome } = setup();
    writeFileSync(join(workspace, 'a.txt'), 'before');
    const service = new MutationService(workspace, krossHome);

    await expect(
      service.record({
        runId: 'run-fail',
        toolName: 'ApplyPatch',
        paths: ['a.txt'],
        action: async () => {
          writeFileSync(join(workspace, 'a.txt'), 'partial');
          throw new Error('boom');
        }
      })
    ).rejects.toThrow('boom');
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('before');
    expect(service.listActive()).toEqual([]);
  });

  it('recovers an incomplete prepared transaction on restart', async () => {
    const { workspace, krossHome } = setup();
    writeFileSync(join(workspace, 'a.txt'), 'before');
    const first = new MutationService(workspace, krossHome);
    await first.record({
      runId: 'seed',
      toolName: 'Write',
      paths: ['a.txt'],
      action: async () => writeFileSync(join(workspace, 'a.txt'), 'after')
    });
    const pre = first.listActive()[0]!.pre;
    const incomplete = first.journal.createPrepared({
      runId: 'crashed',
      toolName: 'Write',
      pre
    });
    first.journal.appendPrepared(incomplete);
    writeFileSync(join(workspace, 'a.txt'), 'partial crash output');

    const recovered = new MutationService(workspace, krossHome);

    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('before');
    expect(recovered.journal.listIncomplete()).toEqual([]);
  });
});
