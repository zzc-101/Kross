import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { materializeExecutionWorkspace, safeJoin, type MaterializableRunSpec } from './sourceMaterializer';

describe('Source materialization', () => {
  it('creates a metadata-only manifest and verifies bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kross-work-'));
    const bytes = Buffer.from('untrusted source text');
    const runSpec = {
      runId: 'run1', repository: undefined,
      sources: [{ id: 'source1', kind: 'upload', displayName: 'input', fileName: 'input.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]
    } as MaterializableRunSpec;
    const workspace = await materializeExecutionWorkspace({
      runSpec, physicalRoot: root,
      downloader: { downloadToFile: async ({ destination }) => { await writeFile(destination, bytes); } }
    });
    const manifest = await readFile(workspace.manifestPath, 'utf8');
    expect(manifest).toContain('source1');
    expect(manifest).not.toContain('untrusted source text');
  });

  it('rejects traversal outside the execution root', () => {
    expect(() => safeJoin('/work', '..', 'escape')).toThrow('Unsafe workspace path');
  });

  it('rejects aggregate Source bytes before downloading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kross-work-'));
    const downloadToFile = async () => { throw new Error('must not download'); };
    const runSpec = {
      runId: 'run1', resourceLimits: { maxSourceBytes: 1 },
      sources: [{ id: 'source1', kind: 'upload', displayName: 'input', fileName: 'input.txt', mimeType: 'text/plain', sizeBytes: 2, sha256: 'a'.repeat(64), downloadUrl: 'https://example.test', downloadHeaders: [] }]
    } satisfies MaterializableRunSpec;
    await expect(materializeExecutionWorkspace({ runSpec, physicalRoot: root, downloader: { downloadToFile } })).rejects.toThrow('Sources exceed 1 bytes');
  });
});
