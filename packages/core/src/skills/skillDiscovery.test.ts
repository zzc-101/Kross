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

import { discoverSkills } from './skillDiscovery';
import { SkillRegistry } from './skillRegistry';

let tempRoot = '';

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

function setup() {
  tempRoot = mkdtempSync(join(tmpdir(), 'kross-skills-'));
  const personal = join(tempRoot, 'personal');
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(personal);
  mkdirSync(workspace);
  return { personal, workspace };
}

function writeSkill(root: string, id: string, body: string): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
  return dir;
}

describe('discoverSkills', () => {
  it('discovers personal and scoped project metadata without loading bodies', () => {
    const { personal, workspace } = setup();
    writeSkill(
      personal,
      'review',
      '---\nname: Review\ndescription: Review code carefully\n---\nSECRET BODY'
    );
    writeSkill(
      join(workspace, '.agents', 'skills'),
      'deploy',
      '---\nname: Deploy\ndescription: Deploy this workspace\n---\nDEPLOY BODY'
    );

    const snapshot = discoverSkills({
      personalSkillsDir: personal,
      roots: [{ id: 'app', path: workspace, primary: true }]
    });

    expect(snapshot.skills.map((skill) => skill.descriptorId)).toEqual([
      'personal:review',
      'workspace:app:deploy'
    ]);
    expect(snapshot.skills[1]).toMatchObject({
      id: 'deploy',
      name: 'Deploy',
      description: 'Deploy this workspace',
      rootId: 'app',
      scope: 'workspace'
    });
    expect(JSON.stringify(snapshot)).not.toContain('DEPLOY BODY');
  });

  it('falls back to the first paragraph for missing descriptions', () => {
    const { personal } = setup();
    writeSkill(personal, 'plain', '# Plain\n\nUse this for plain tasks.\n\nMore detail.');

    const skill = discoverSkills({ roots: [], personalSkillsDir: personal }).skills[0];

    expect(skill).toMatchObject({
      id: 'plain',
      name: 'plain',
      description: '# Plain Use this for plain tasks.'
    });
  });

  it('reports invalid UTF-8 skill files without exposing content', () => {
    const { personal } = setup();
    const dir = join(personal, 'invalid');
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), Buffer.from([0xff, 0xfe]));

    const snapshot = discoverSkills({ roots: [], personalSkillsDir: personal });

    expect(snapshot.skills).toEqual([]);
    expect(snapshot.diagnostics[0]?.code).toBe('read-failed');
  });

  it('rejects a SKILL.md symlink that escapes its skill directory', () => {
    const { personal } = setup();
    const dir = join(personal, 'escape');
    mkdirSync(dir);
    const outside = join(tempRoot, 'outside.md');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(dir, 'SKILL.md'));

    const snapshot = discoverSkills({ roots: [], personalSkillsDir: personal });

    expect(snapshot.skills).toEqual([]);
    expect(snapshot.diagnostics[0]?.code).toBe('outside-root');
  });

  it('rejects an escaped project skills directory and prioritizes project metadata limits', () => {
    const { personal, workspace } = setup();
    writeSkill(personal, 'personal-only', 'personal');
    const externalSkills = join(tempRoot, 'external-skills');
    writeSkill(externalSkills, 'escaped', 'escaped');
    mkdirSync(join(workspace, '.agents'), { recursive: true });
    symlinkSync(externalSkills, join(workspace, '.agents', 'skills'));

    const escaped = discoverSkills({
      personalSkillsDir: personal,
      roots: [{ id: 'app', path: workspace, primary: true }]
    });
    expect(escaped.skills.map((skill) => skill.id)).toEqual(['personal-only']);
    expect(escaped.diagnostics.some((item) => item.code === 'outside-root')).toBe(true);

    rmSync(join(workspace, '.agents', 'skills'));
    writeSkill(join(workspace, '.agents', 'skills'), 'project-only', 'project');
    const limited = discoverSkills({
      personalSkillsDir: personal,
      roots: [{ id: 'app', path: workspace, primary: true }],
      maxSkills: 1
    });
    expect(limited.skills.map((skill) => skill.id)).toEqual(['project-only']);
    expect(limited.diagnostics.some((item) => item.code === 'limit')).toBe(true);
  });
});

describe('SkillRegistry', () => {
  it('prefers the selected workspace skill over a personal skill with the same id', () => {
    const { personal, workspace } = setup();
    writeSkill(personal, 'review', 'Personal review body');
    writeSkill(join(workspace, '.agents', 'skills'), 'review', 'Workspace review body');
    const registry = new SkillRegistry({
      personalSkillsDir: personal,
      getRoots: () => [{ id: 'app', path: workspace, primary: true }]
    });

    expect(registry.read({ id: 'review', rootId: 'app' }).content).toContain(
      'Workspace review body'
    );
    expect(registry.read({ id: 'review' }).content).toContain('Personal review body');
  });

  it('reads bounded resources and blocks resource symlink escape', () => {
    const { personal } = setup();
    const dir = writeSkill(personal, 'docs', 'Read references when needed.');
    mkdirSync(join(dir, 'references'));
    writeFileSync(join(dir, 'references', 'guide.md'), 'line 1\nline 2\nline 3');
    const outside = join(tempRoot, 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(dir, 'references', 'escape.txt'));
    const registry = new SkillRegistry({
      personalSkillsDir: personal,
      getRoots: () => []
    });

    expect(
      registry.read({ id: 'docs', resource: 'references/guide.md', offset: 1, limit: 1 })
        .content
    ).toBe('line 2');
    expect(() =>
      registry.read({ id: 'docs', resource: 'references/escape.txt' })
    ).toThrow(/outside skill directory/i);
  });
});
