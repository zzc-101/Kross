import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runServerMigrations } from './serverMigrations';

describe('runServerMigrations', () => {
  it('plans and applies legacy control-plane files independently from Core', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-cloud-migration-'));
    writeFileSync(join(root, 'workspaces.json'), JSON.stringify([]));
    writeFileSync(
      join(root, 'provider.json'),
      JSON.stringify({
        provider: 'openai',
        model: 'test',
        apiKey: 'secret'
      })
    );
    writeFileSync(
      join(root, 'push-subscriptions.json'),
      JSON.stringify([{ endpoint: 'https://push.example' }])
    );

    const planned = await runServerMigrations({ dataDir: root });
    expect(planned).toMatchObject({
      boundary: 'cloud-control-plane',
      mode: 'dry-run',
      status: 'planned'
    });
    expect(planned.changes.map((change) => change.relativePath)).toEqual([
      'workspaces.json',
      'provider.json',
      'push-subscriptions.json'
    ]);
    expect(JSON.parse(readFileSync(join(root, 'workspaces.json'), 'utf8')))
      .toEqual([]);

    const applied = await runServerMigrations({
      dataDir: root,
      apply: true,
      now: () => new Date('2026-07-27T00:00:00.000Z')
    });
    expect(applied.status).toBe('applied');
    expect(applied.backupPath).toContain('.migration-backups/cloud-');
    expect(JSON.parse(readFileSync(join(root, 'workspaces.json'), 'utf8')))
      .toEqual({ version: 1, workspaces: [] });
    expect(JSON.parse(readFileSync(join(root, 'provider.json'), 'utf8')))
      .toMatchObject({ version: 1, apiKey: 'secret' });
    expect(
      JSON.parse(readFileSync(join(root, 'push-subscriptions.json'), 'utf8'))
    ).toMatchObject({ version: 1, subscriptions: [{ endpoint: 'https://push.example' }] });
    expect(existsSync(join(root, '.cloud-migration.lock'))).toBe(false);
    expect((await runServerMigrations({ dataDir: root })).status).toBe('noop');
  });

  it('rolls back files already written when a later write fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-cloud-rollback-'));
    const workspaces = JSON.stringify([]);
    const provider = JSON.stringify({
      provider: 'openai',
      model: 'test',
      apiKey: 'secret'
    });
    writeFileSync(join(root, 'workspaces.json'), workspaces);
    writeFileSync(join(root, 'provider.json'), provider);

    const result = await runServerMigrations({
      dataDir: root,
      apply: true,
      beforeWrite: (_path, index) => {
        if (index === 1) throw new Error('injected failure');
      }
    });

    expect(result.status).toBe('rolled-back');
    expect(readFileSync(join(root, 'workspaces.json'), 'utf8')).toBe(workspaces);
    expect(readFileSync(join(root, 'provider.json'), 'utf8')).toBe(provider);
  });

  it('blocks future versions, invalid JSON, symlinks, and concurrent runs', async () => {
    const futureRoot = mkdtempSync(join(tmpdir(), 'kross-cloud-future-'));
    writeFileSync(
      join(futureRoot, 'provider.json'),
      JSON.stringify({ version: 2, provider: 'openai' })
    );
    expect(await runServerMigrations({ dataDir: futureRoot })).toMatchObject({
      status: 'blocked',
      error: 'unsupported provider.json version: 2'
    });

    const invalidRoot = mkdtempSync(join(tmpdir(), 'kross-cloud-invalid-'));
    writeFileSync(join(invalidRoot, 'workspaces.json'), '{');
    expect(await runServerMigrations({ dataDir: invalidRoot })).toMatchObject({
      status: 'blocked',
      error: 'invalid JSON: workspaces.json'
    });

    const lockedRoot = mkdtempSync(join(tmpdir(), 'kross-cloud-locked-'));
    writeFileSync(join(lockedRoot, 'workspaces.json'), JSON.stringify([]));
    writeFileSync(join(lockedRoot, '.cloud-migration.lock'), 'locked');
    expect(
      await runServerMigrations({ dataDir: lockedRoot, apply: true })
    ).toMatchObject({
      status: 'blocked',
      error: 'another cloud migration is already running'
    });
  });
});
