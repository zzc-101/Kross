import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectOutputArtifacts } from './artifactCollector';

describe('Artifact collection', () => {
  it('recursively discovers metadata and hashes without returning content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kross-artifacts-'));
    await mkdir(join(root, 'reports'));
    await writeFile(join(root, 'reports', 'result.md'), '# Result');
    const artifacts = await collectOutputArtifacts({ outputDirectory: root, maxTotalBytes: 100 });
    expect(artifacts).toMatchObject([{ relativePath: 'reports/result.md', displayName: 'reports/result.md', kind: 'document', mimeType: 'text/markdown', sizeBytes: 8 }]);
    expect(artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(artifacts)).not.toContain('# Result');
  });

  it('rejects aggregate overflow and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kross-artifacts-'));
    await writeFile(join(root, 'large.bin'), '12345');
    await expect(collectOutputArtifacts({ outputDirectory: root, maxTotalBytes: 4 })).rejects.toThrow('exceeds 4 bytes');
    const linked = await mkdtemp(join(tmpdir(), 'kross-artifacts-'));
    await symlink(join(root, 'large.bin'), join(linked, 'escape.bin'));
    await expect(collectOutputArtifacts({ outputDirectory: linked, maxTotalBytes: 100 })).rejects.toThrow('symbolic link');
  });
});
