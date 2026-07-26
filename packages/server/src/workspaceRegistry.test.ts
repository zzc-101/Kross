import {
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WorkspaceRegistry } from './workspaceRegistry';

describe('WorkspaceRegistry persistence', () => {
  it('writes version 1 and rejects future versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-workspace-registry-'));
    const path = join(root, 'workspaces.json');
    const registry = new WorkspaceRegistry(path);
    registry.put({
      workspace: {
        id: 'workspace-1',
        name: 'Workspace',
        gitUrl: 'https://github.com/example/repository.git',
        status: 'stopped',
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z'
      },
      containerName: 'worker-1',
      volumeName: 'volume-1',
      workerToken: 'secret'
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);

    writeFileSync(path, JSON.stringify({ version: 2, workspaces: [] }));
    expect(() => new WorkspaceRegistry(path)).toThrow(
      'Workspace registry 使用不受支持的数据版本 2'
    );
  });
});
