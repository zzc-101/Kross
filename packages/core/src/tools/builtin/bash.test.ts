import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './paths';
import { createBashTool } from './bash';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-bash-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(input: any) {
  const tool = createBashTool(root);
  return tool.execute({
    runId: 'run-1',
    toolName: tool.name,
    input,
    signal: new AbortController().signal
  });
}

describe('Bash', () => {
  it('executes a command and returns output', async () => {
    const result = await run({ command: 'echo hello' });
    expect(result.content).toContain('hello');
    expect(result.summary).toContain('exit=0');
  });

  it('runs inside the workspace root by default', async () => {
    await writeFile(join(root, 'marker.txt'), 'x');
    const result = await run({ command: 'ls' });
    expect(result.content).toContain('marker.txt');
  });

  it('rejects cwd outside the workspace', async () => {
    await expect(run({ command: 'echo hi', cwd: '/etc' })).rejects.toThrow(
      ToolBoundaryError
    );
  });
});
