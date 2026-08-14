import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TodoStore } from '../../todo/todoStore';
import { MutationCoordinator } from '../../mutations/mutationService';
import { createApprovalPolicy } from '../permissionModes';
import { ToolGateway, ToolPermissionError } from '../toolGateway';
import { builtinToolNames, createBuiltinTools } from './index';

let root: string;
let outsideRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-builtin-'));
  outsideRoot = await mkdtemp(join(tmpdir(), 'kross-full-access-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

function makeGateway(): ToolGateway {
  const gateway = new ToolGateway({ defaultTimeoutMs: 1000 });
  for (const tool of createBuiltinTools(root)) {
    gateway.register(tool);
  }
  return gateway;
}

describe('builtin tools integration', () => {
  it('registers core builtin tools (Task/Todo require extra wiring)', () => {
    const gateway = makeGateway();
    const names = gateway.listTools({ mode: 'auto' }).map((t) => t.name);
    const coreOnly = [...builtinToolNames].filter(
      (name) =>
        name !== 'Task' &&
        name !== 'TodoWrite' &&
        name !== 'TodoRead' &&
        name !== 'SetMode' &&
        name !== 'ReadSkill' &&
        name !== 'ApplyPatch' &&
        !name.startsWith('Process')
    );
    expect(names.sort()).toEqual(coreOnly.sort());
  });

  it('registers Task and Todo tools when wired', () => {
    const gateway = new ToolGateway({ defaultTimeoutMs: 1000 });
    for (const tool of createBuiltinTools(root, {
      includeTask: true,
      runSubagent: async () => {
        throw new Error('not used');
      },
      todoStore: new TodoStore()
    })) {
      gateway.register(tool);
    }
    const names = gateway.listTools({ mode: 'auto' }).map((t) => t.name);
    expect(names).toContain('Task');
    expect(names).toContain('TodoWrite');
    expect(names).toContain('TodoRead');
  });

  it('allows read tools without approval', async () => {
    await writeFile(join(root, 'f.txt'), 'hi');
    const gateway = makeGateway();
    const res = await gateway.call({
      runId: 'r',
      name: 'Read',
      input: { path: 'f.txt' },
      returnErrors: true
    });
    expect(res.status).toBe('completed');
    expect(res.content).toBe('hi');
  });

  it('requires approval for execute/write tools without a runtime policy', async () => {
    const gateway = makeGateway();
    await expect(
      gateway.call({ runId: 'r', name: 'Bash', input: { command: 'echo hi' } })
    ).rejects.toThrow(ToolPermissionError);
  });

  it('keeps paths workspace-scoped until full-access mode selects system scope', async () => {
    const outsideFile = join(outsideRoot, 'outside.txt');
    await writeFile(outsideFile, 'outside');
    const gateway = makeGateway();

    await expect(
      gateway.call({
        runId: 'workspace',
        name: 'Read',
        input: { path: outsideFile }
      })
    ).rejects.toThrow('路径超出 workspace 范围');

    gateway.setAccessScope('system');
    await expect(
      gateway.call({
        runId: 'system',
        name: 'Read',
        input: { path: outsideFile }
      })
    ).resolves.toMatchObject({ content: 'outside' });
  });

  it('journals full-access writes outside the primary workspace', async () => {
    const target = join(outsideRoot, 'outside.txt');
    await writeFile(target, 'before');
    const coordinator = new MutationCoordinator(join(root, '.kross'));
    const gateway = new ToolGateway({
      approvalPolicy: createApprovalPolicy('auto')
    });
    gateway.setAccessScope('system');
    for (const tool of createBuiltinTools(root, {
      mutationService: coordinator.forWorkspace(root),
      mutationCoordinator: coordinator
    })) {
      gateway.register(tool);
    }

    await gateway.call({
      runId: 'system-write',
      name: 'Write',
      input: { path: target, content: 'after' }
    });
    expect(await readFile(target, 'utf8')).toBe('after');

    coordinator.undo('system-write');
    expect(await readFile(target, 'utf8')).toBe('before');
  });
});
