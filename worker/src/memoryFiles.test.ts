import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { clipBudget, loadMemoryContextSources } from './memoryFiles';

describe('memory file injection', () => {
  it('injects preference and fact files and skips stubs', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-memory-'));
    writeFileSync(join(root, 'USER.md'), '# User\n\n- 用中文回复\n');
    writeFileSync(join(root, 'MEMORY.md'), '# Memory\n\n- 项目用 Java 21\n');
    const sources = loadMemoryContextSources(root);
    expect(sources.map((item) => item.id)).toEqual(['user-preferences', 'long-term-memory']);
    expect(sources[0]?.pinned).toBe(true);
    expect(sources[1]?.content).toContain('Java 21');
  });

  it('skips default stubs and missing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-memory-stub-'));
    writeFileSync(join(root, 'USER.md'), '# User\n\nDescribe preferences for this Agent.\n');
    expect(loadMemoryContextSources(root)).toEqual([]);
    expect(loadMemoryContextSources(undefined)).toEqual([]);
  });

  it('clips injected content to the budget', () => {
    expect(clipBudget('abc', 10)).toBe('abc');
    expect(clipBudget('abcdefghij', 4).endsWith('…')).toBe(true);
  });
});
