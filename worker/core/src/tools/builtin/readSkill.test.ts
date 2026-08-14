import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillRegistry } from '../../skills/skillRegistry';
import { createReadSkillTool } from './readSkill';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('ReadSkill', () => {
  it('returns bounded content and enforces the per-run cumulative budget', async () => {
    root = mkdtempSync(join(tmpdir(), 'kross-read-skill-'));
    const dir = join(root, 'large');
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), 'x'.repeat(70 * 1024));
    const registry = new SkillRegistry({
      getRoots: () => [],
      personalSkillsDir: root
    });
    const tool = createReadSkillTool(registry);
    const context = {
      runId: 'run-1',
      toolName: 'ReadSkill',
      input: { id: 'large' },
      signal: new AbortController().signal
    };

    const first = await tool.execute(context);
    expect(Buffer.byteLength(first.content)).toBe(64 * 1024);
    expect(first.data).toMatchObject({ truncated: true });
    await tool.execute(context);
    await expect(tool.execute(context)).rejects.toThrow(/budget exceeded/i);
  });
});
