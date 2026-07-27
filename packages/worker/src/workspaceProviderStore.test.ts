import { readFileSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WorkspaceProviderStore } from './workspaceProviderStore';

describe('WorkspaceProviderStore', () => {
  it('persists secrets privately but only returns redacted profiles', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-workspace-provider-'));
    const path = join(root, 'workspace-providers.json');
    const store = new WorkspaceProviderStore(path);
    const profile = store.upsert({
      label: 'Private',
      provider: 'openai',
      model: 'private-model',
      apiKey: 'workspace-secret'
    });

    expect(profile).toMatchObject({
      scope: 'workspace',
      hasApiKey: true,
      model: 'private-model'
    });
    expect(JSON.stringify(profile)).not.toContain('workspace-secret');
    expect(readFileSync(path, 'utf8')).toContain('workspace-secret');
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(new WorkspaceProviderStore(path).list()).toEqual([profile]);
    expect(store.delete(profile.id)).toBe(true);
  });
});
