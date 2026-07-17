import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';

import {
  collectAllowedWorkspaceRoots,
  formatRegistryForPrompt,
  loadProjectRegistry,
  selectActiveProject
} from './projectRegistry';

let tmp: string;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

describe('projectRegistry', () => {
  it('returns undefined when projects.json is missing', () => {
    tmp = mkdtempSync(join(tmpdir(), 'kross-reg-'));
    const loaded = loadProjectRegistry({ krossHome: tmp });
    expect(loaded).toBeUndefined();
  });

  it('loads and normalizes absolute repo paths', () => {
    tmp = mkdtempSync(join(tmpdir(), 'kross-reg-'));
    const api = join(tmp, 'api');
    const web = join(tmp, 'web');
    mkdirSync(api);
    mkdirSync(web);
    writeFileSync(
      join(tmp, 'projects.json'),
      JSON.stringify({
        defaultProjectId: 'demo',
        projects: {
          demo: {
            repos: [
              { id: 'api', path: api, type: 'backend' },
              { id: 'web', path: web, type: 'frontend' }
            ]
          }
        }
      })
    );

    const loaded = loadProjectRegistry({ krossHome: tmp });
    expect(loaded?.registry.defaultProjectId).toBe('demo');
    expect(loaded?.registry.projects.demo?.repos.map((r) => r.id)).toEqual([
      'api',
      'web'
    ]);
    expect(loaded?.registry.projects.demo?.repos[0]?.path).toBe(api);
  });

  it('selects project by cwd match, then default, then sole', () => {
    const registry = {
      defaultProjectId: 'demo',
      projects: {
        demo: {
          repos: [
            { id: 'api', path: '/tmp/demo-api', type: 'backend' },
            { id: 'web', path: '/tmp/demo-web', type: 'frontend' }
          ]
        },
        other: {
          repos: [{ id: 'x', path: '/tmp/other', type: 'lib' }]
        }
      }
    };

    expect(
      selectActiveProject(registry, { workspaceRoot: '/tmp/demo-web/src' })
        ?.projectId
    ).toBe('demo');

    expect(
      selectActiveProject(registry, { workspaceRoot: '/tmp/unrelated' })
        ?.projectId
    ).toBe('demo');

    expect(
      selectActiveProject(registry, { activeProjectId: 'other' })?.projectId
    ).toBe('other');
  });

  it('collects allowlist roots from registry + cwd', () => {
    const roots = collectAllowedWorkspaceRoots(
      {
        projects: {
          p: {
            repos: [
              { id: 'a', path: '/repos/a', type: 'backend' },
              { id: 'b', path: '/repos/b', type: 'frontend' }
            ]
          }
        }
      },
      '/cwd'
    );
    expect(roots).toContain(resolve('/cwd'));
    expect(roots).toContain(resolve('/repos/a'));
    expect(roots).toContain(resolve('/repos/b'));
  });

  it('formats prompt text', () => {
    const text = formatRegistryForPrompt(
      {
        projectId: 'demo',
        project: {
          repos: [{ id: 'api', path: '/x/api', type: 'backend' }]
        },
        reason: 'test'
      },
      '/home/.kross/projects.json'
    );
    expect(text).toContain('Active project: demo');
    expect(text).toContain('id=api');
    expect(text).toContain('/home/.kross/projects.json');
  });
});
