import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  it('registers all builtin tools', () => {
    const gateway = makeGateway();
    const names = gateway.listTools({ mode: 'normal' }).map((t) => t.name);
    expect(names.sort()).toEqual([...builtinToolNames].sort());
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
