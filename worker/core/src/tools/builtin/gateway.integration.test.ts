import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TodoStore } from '../../todo/todoStore';
import { ToolGateway } from '../toolGateway';
import { createSaasTools, saasToolNames } from './index';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-builtin-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeGateway(): ToolGateway {
  const gateway = new ToolGateway({ defaultTimeoutMs: 1000 });
  for (const tool of createSaasTools(root)) {
    gateway.register(tool);
  }
  return gateway;
}

describe('SaaS tools integration', () => {
  it('registers the default work tools without development-only tools', () => {
    const gateway = makeGateway();
    const names = gateway.listTools().map((t) => t.name);
    const coreOnly = [...saasToolNames].filter(
      (name) =>
        name !== 'Task' &&
        name !== 'TodoWrite' &&
        name !== 'TodoRead' &&
        name !== 'ReadSkill'
    );
    expect(names.sort()).toEqual(coreOnly.sort());
    expect(names).not.toEqual(
      expect.arrayContaining([
        'Bash',
        'Git',
        'ApplyPatch',
        'ProcessStart',
        'ProcessPoll',
        'ProcessWrite',
        'ProcessKill',
        'ProcessList'
      ])
    );
  });

  it('registers Task and Todo tools when wired', () => {
    const gateway = new ToolGateway({ defaultTimeoutMs: 1000 });
    for (const tool of createSaasTools(root, {
      includeTask: true,
      runSubagent: async () => {
        throw new Error('not used');
      },
      todoStore: new TodoStore()
    })) {
      gateway.register(tool);
    }
    const names = gateway.listTools().map((t) => t.name);
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

  it('keeps paths workspace-scoped', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'kross-outside-'));
    const outsideFile = join(outsideRoot, 'outside.txt');
    await writeFile(outsideFile, 'outside');
    const gateway = makeGateway();

    try {
      await expect(
        gateway.call({
          runId: 'workspace',
          name: 'Read',
          input: { path: outsideFile }
        })
      ).rejects.toThrow('路径超出 workspace 范围');
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
