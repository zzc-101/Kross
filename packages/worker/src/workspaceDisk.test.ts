import { describe, expect, it } from 'vitest';

import {
  formatDiskBytes,
  measureWorkspaceDiskUsage
} from './workspaceDisk';

describe('workspace disk quota helpers', () => {
  it('sums du output and avoids counting nested roots twice', async () => {
    const seen: string[][] = [];
    const bytes = await measureWorkspaceDiskUsage(
      ['/workspace', '/workspace/repo', '/data'],
      async (paths) => {
        seen.push(paths);
        return {
          stdout: '1024\t/workspace\n512\t/data\n',
          stderr: ''
        };
      }
    );

    expect(seen[0]).toEqual(['/data', '/workspace']);
    expect(bytes).toBe(1536 * 1024);
  });

  it('formats quota messages for users', () => {
    expect(formatDiskBytes(2 * 1024 ** 3)).toBe('2.0 GiB');
    expect(formatDiskBytes(128 * 1024 ** 2)).toBe('128.0 MiB');
  });
});
