import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCoreMigrations } from './coreMigrations';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runCoreMigrations', () => {
  it('defaults to a read-only dry-run with hashed planned changes', async () => {
    const root = createRoot();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ locale: 'zh-CN' }));

    const report = await runCoreMigrations({ krossHome: root });

    expect(report).toMatchObject({
      version: 1,
      boundary: 'core-local',
      mode: 'dry-run',
      status: 'planned',
      changes: [
        {
          stepId: 'core.config.version-1',
          relativePath: 'config.json',
          beforeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      ]
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      locale: 'zh-CN'
    });
    expect(existsSync(join(root, '.migration-backups'))).toBe(false);
  });

  it('backs up and atomically applies legacy version anchors', async () => {
    const root = createRoot();
    writeFileSync(join(root, 'config.json'), JSON.stringify({ locale: 'en' }));
    writeFileSync(
      join(root, 'projects.json'),
      JSON.stringify({ projects: {} })
    );

    const report = await runCoreMigrations({
      krossHome: root,
      apply: true,
      now: () => new Date('2026-07-26T12:00:00.000Z')
    });

    expect(report.status).toBe('applied');
    expect(report.changes).toHaveLength(2);
    expect(report.backupPath).toBeTruthy();
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toMatchObject({
      locale: 'en',
      version: 1
    });
    expect(
      JSON.parse(readFileSync(join(root, 'projects.json'), 'utf8'))
    ).toMatchObject({ projects: {}, version: 1 });
    expect(
      JSON.parse(
        readFileSync(join(report.backupPath!, 'manifest.json'), 'utf8')
      )
    ).toMatchObject({
      version: 1,
      boundary: 'core-local',
      files: expect.arrayContaining([
        expect.objectContaining({ relativePath: 'config.json' }),
        expect.objectContaining({ relativePath: 'projects.json' })
      ])
    });
    expect(
      JSON.parse(
        readFileSync(
          join(report.backupPath!, 'files', 'config.json'),
          'utf8'
        )
      )
    ).toEqual({ locale: 'en' });
  });

  it('rolls back already written files when a later write fails', async () => {
    const root = createRoot();
    const originalConfig = '{"locale":"en"}';
    const originalProjects = '{"projects":{}}';
    writeFileSync(join(root, 'config.json'), originalConfig);
    writeFileSync(join(root, 'projects.json'), originalProjects);

    const report = await runCoreMigrations({
      krossHome: root,
      apply: true,
      beforeWrite: (_path, index) => {
        if (index === 1) throw new Error('injected write failure');
      }
    });

    expect(report).toMatchObject({
      status: 'rolled-back',
      error: 'injected write failure',
      backupPath: expect.any(String)
    });
    expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe(originalConfig);
    expect(readFileSync(join(root, 'projects.json'), 'utf8')).toBe(
      originalProjects
    );
  });

  it('blocks future versions and concurrent apply locks', async () => {
    const root = createRoot();
    writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 2 }));
    await expect(runCoreMigrations({ krossHome: root })).resolves.toMatchObject({
      status: 'blocked',
      error: expect.stringContaining('unsupported config.json version')
    });

    writeFileSync(join(root, 'config.json'), JSON.stringify({ locale: 'en' }));
    writeFileSync(join(root, '.migration.lock'), 'held');
    await expect(
      runCoreMigrations({ krossHome: root, apply: true })
    ).resolves.toMatchObject({
      status: 'blocked',
      error: 'another migration is already running'
    });
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toEqual({
      locale: 'en'
    });
  });

  it('never accepts a filesystem root as the migration boundary', async () => {
    const root = process.platform === 'win32' ? 'C:\\' : '/';
    await expect(runCoreMigrations({ krossHome: root })).resolves.toMatchObject({
      status: 'blocked',
      error: 'migration root cannot be a filesystem root'
    });
  });
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kross-core-migration-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}
