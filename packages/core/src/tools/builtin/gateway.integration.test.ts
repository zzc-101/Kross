import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TodoStore } from '../../todo/todoStore';
import { ToolGateway, ToolPermissionError } from '../toolGateway';
import { builtinToolNames, createBuiltinTools } from './index';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-builtin-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
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
        name !== 'SetMode'
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

  it('requires approval for execute/write tools', async () => {
    const gateway = makeGateway();
    await expect(
      gateway.call({ runId: 'r', name: 'Bash', input: { command: 'echo hi' } })
    ).rejects.toThrow(ToolPermissionError);
  });
});
