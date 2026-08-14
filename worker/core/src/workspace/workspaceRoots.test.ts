import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceRoots } from './workspaceRoots';

let root: string;

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('WorkspaceRoots', () => {
  it('tracks primary and added dirs with ids', () => {
    root = mkdtempSync(join(tmpdir(), 'kross-roots-'));
    const primary = join(root, 'main');
    const other = join(root, 'api');
    mkdirSync(primary);
    mkdirSync(other);

    const roots = new WorkspaceRoots(primary);
    expect(roots.list()).toHaveLength(1);
    const added = roots.add(other);
    expect(added.id).toBe('api');
    expect(roots.allowedRoots()).toContain(other);
    expect(roots.resolveById('api')).toBe(other);
    expect(roots.remove('api')).toBe(true);
    expect(roots.list()).toHaveLength(1);
  });

  it('rejects files and missing paths', () => {
    root = mkdtempSync(join(tmpdir(), 'kross-roots-'));
    const primary = join(root, 'main');
    mkdirSync(primary);
    const file = join(root, 'f.txt');
    writeFileSync(file, 'x');
    const roots = new WorkspaceRoots(primary);
    expect(() => roots.add(file)).toThrow(/Not a directory/);
    expect(() => roots.add(join(root, 'missing'))).toThrow(/does not exist/);
  });

  it('builds impact map from roots', () => {
    root = mkdtempSync(join(tmpdir(), 'kross-roots-'));
    const primary = join(root, 'app');
    const web = join(root, 'web');
    mkdirSync(primary);
    mkdirSync(web);
    const roots = new WorkspaceRoots(primary);
    roots.add(web);
    const impact = roots.toImpactMap('前后端联动');
    expect(impact.projectId).toBe('workspace');
    expect(impact.repos.map((r) => r.id)).toEqual(
      expect.arrayContaining(['app', 'web'])
    );
  });
});
