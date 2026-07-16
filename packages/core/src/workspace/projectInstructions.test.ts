import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  formatProjectInstructionSource,
  loadProjectInstructions,
  type ProjectInstructionRoot
} from './projectInstructions';

let tempRoot = '';

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

function makeRoot(id: string, primary = false): ProjectInstructionRoot {
  if (!tempRoot) {
    tempRoot = mkdtempSync(join(tmpdir(), 'kross-instructions-'));
  }
  const path = join(tempRoot, id);
  mkdirSync(path);
  return { id, path, primary };
}

describe('loadProjectInstructions', () => {
  it('returns an empty snapshot when no instruction files exist', () => {
    const root = makeRoot('main', true);

    const snapshot = loadProjectInstructions({ roots: [root] });

    expect(snapshot.files).toEqual([]);
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.totalOriginalBytes).toBe(0);
    expect(snapshot.totalInjectedBytes).toBe(0);
    expect(snapshot.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it('loads root metadata and renders files in override order', () => {
    const root = makeRoot('main', true);
    writeFileSync(join(root.path, 'KROSS.md'), 'kross rules');
    writeFileSync(join(root.path, 'CLAUDE.md'), 'claude rules');
    writeFileSync(join(root.path, 'AGENTS.md'), 'agent rules');

    const snapshot = loadProjectInstructions({ roots: [root] });

    expect(snapshot.files.map((file) => file.filename)).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
      'KROSS.md'
    ]);
    expect(snapshot.files[1]).toMatchObject({
      sourceId: 'project-instruction:main:AGENTS.md',
      rootId: 'main',
      rootPath: root.path,
      relativePath: 'AGENTS.md',
      content: 'agent rules',
      truncated: false
    });
  });

  it('keeps the primary root first and assigns unique source ids', () => {
    const extra = makeRoot('extra');
    const primary = makeRoot('main', true);
    writeFileSync(join(extra.path, 'AGENTS.md'), 'extra');
    writeFileSync(join(primary.path, 'AGENTS.md'), 'main');

    const snapshot = loadProjectInstructions({ roots: [extra, primary] });

    expect(snapshot.files.map((file) => file.rootId)).toEqual(['main', 'extra']);
    expect(new Set(snapshot.files.map((file) => file.sourceId)).size).toBe(2);
  });

  it('reports empty and non-file candidates', () => {
    const root = makeRoot('main', true);
    writeFileSync(join(root.path, 'AGENTS.md'), '');
    mkdirSync(join(root.path, 'KROSS.md'));

    const snapshot = loadProjectInstructions({ roots: [root] });

    expect(snapshot.files).toEqual([]);
    expect(snapshot.diagnostics.map((item) => item.code)).toEqual([
      'empty',
      'not-file'
    ]);
  });

  it('rejects symlinks outside the root but permits an in-root target', () => {
    const root = makeRoot('main', true);
    const outside = join(tempRoot, 'outside.md');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(root.path, 'AGENTS.md'));

    const rejected = loadProjectInstructions({ roots: [root] });
    expect(rejected.files).toEqual([]);
    expect(rejected.diagnostics[0]?.code).toBe('outside-root');

    rmSync(join(root.path, 'AGENTS.md'));
    writeFileSync(join(root.path, 'rules.md'), 'inside');
    symlinkSync(join(root.path, 'rules.md'), join(root.path, 'AGENTS.md'));

    const accepted = loadProjectInstructions({ roots: [root] });
    expect(accepted.files[0]?.content).toBe('inside');
  });

  it('truncates a file with UTF-8 safe head and tail content', () => {
    const root = makeRoot('main', true);
    const content = `${'开头'.repeat(40)}--middle--${'结尾'.repeat(40)}`;
    writeFileSync(join(root.path, 'AGENTS.md'), content);

    const snapshot = loadProjectInstructions({
      roots: [root],
      maxFileBytes: 180,
      maxTotalBytes: 1024
    });
    const file = snapshot.files[0]!;

    expect(file.truncated).toBe(true);
    expect(file.content).toContain('开头');
    expect(file.content).toContain('结尾');
    expect(file.content).toContain('truncated');
    expect(file.content).not.toContain('\uFFFD');
    expect(file.injectedBytes).toBeLessThanOrEqual(180);
  });

  it('allocates total budget to primary and higher-precedence files first', () => {
    const primary = makeRoot('main', true);
    const extra = makeRoot('extra');
    writeFileSync(join(primary.path, 'CLAUDE.md'), 'c'.repeat(80));
    writeFileSync(join(primary.path, 'KROSS.md'), 'k'.repeat(80));
    writeFileSync(join(extra.path, 'KROSS.md'), 'e'.repeat(80));

    const snapshot = loadProjectInstructions({
      roots: [extra, primary],
      maxFileBytes: 100,
      maxTotalBytes: 100
    });

    expect(snapshot.files.map((file) => `${file.rootId}/${file.filename}`)).toEqual([
      'main/KROSS.md'
    ]);
    expect(snapshot.diagnostics.filter((item) => item.code === 'total-limit')).toHaveLength(2);
  });

  it('formats root scope, source and precedence without leaking extra roots', () => {
    const root = makeRoot('api');
    writeFileSync(join(root.path, 'AGENTS.md'), 'Only run API tests.');
    const file = loadProjectInstructions({ roots: [root] }).files[0]!;

    const formatted = formatProjectInstructionSource(file);

    expect(formatted).toContain('rootId=api');
    expect(formatted).toContain(root.path);
    expect(formatted).toContain('AGENTS.md');
    expect(formatted).toContain('precedence=20');
    expect(formatted).toContain('only applies to workspace root api');
    expect(formatted).toContain('Only run API tests.');
  });
});
