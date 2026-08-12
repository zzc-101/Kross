import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { ArtifactSnapshot } from '@kross/protocol';
import { publishOutputArtifacts } from './artifactPublisher';
import { createRunSpec } from './testFixtures';
import type { ArtifactReservation, WorkerControlTransport, WorkerLeaseIdentity } from './transport';

const lease: WorkerLeaseIdentity = { workerId: 'worker1', runId: 'run1', generation: 1, leaseId: 'lease1' };

describe('Artifact publisher', () => {
  it('reserves, uploads and commits an output with stable idempotency keys', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'kross-publish-'));
    await writeFile(join(outputDirectory, 'report.md'), '# Report');
    const transport = new ArtifactTransport();
    const artifactIds = await publishOutputArtifacts({
      runSpec: createRunSpec(), lease, runToken: 'token', outputDirectory, transport
    });
    expect(artifactIds).toEqual(['artifact1']);
    expect(transport.reserveArtifact).toHaveBeenCalledTimes(1);
    expect(transport.uploadArtifact).toHaveBeenCalledTimes(1);
    expect(transport.commitArtifact).toHaveBeenCalledTimes(1);
    const reserveKey = transport.reserveArtifact.mock.calls[0]?.[0].artifact.idempotencyKey;
    const commitKey = transport.commitArtifact.mock.calls[0]?.[0].commit.idempotencyKey;
    expect(reserveKey).toMatch(/^reserve-[a-f0-9]{64}$/);
    expect(commitKey).toBe(reserveKey?.replace('reserve-', 'commit-'));
  });

  it('does not upload or commit an already committed idempotent reservation', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'kross-publish-'));
    await writeFile(join(outputDirectory, 'result.json'), '{}');
    const transport = new ArtifactTransport();
    transport.reserveArtifact.mockResolvedValue({ artifactId: 'existing', alreadyCommitted: true });
    expect(await publishOutputArtifacts({ runSpec: createRunSpec(), lease, runToken: 'token', outputDirectory, transport })).toEqual(['existing']);
    expect(transport.uploadArtifact).not.toHaveBeenCalled();
    expect(transport.commitArtifact).not.toHaveBeenCalled();
  });
});

class ArtifactTransport implements WorkerControlTransport {
  register = vi.fn();
  sendEvent = vi.fn();
  heartbeat = vi.fn();
  release = vi.fn();
  reserveArtifact = vi.fn(async (_input: Parameters<WorkerControlTransport['reserveArtifact']>[0]): Promise<ArtifactReservation> => ({
    artifactId: 'artifact1', alreadyCommitted: false,
    upload: { method: 'PUT', url: 'https://blob.example.test/upload', headers: [], expiresAt: '2099-01-01T00:00:00.000Z' }
  }));
  uploadArtifact = vi.fn(async (_input: Parameters<WorkerControlTransport['uploadArtifact']>[0]) => ({ etag: 'etag1' }));
  commitArtifact = vi.fn(async (_input: Parameters<WorkerControlTransport['commitArtifact']>[0]): Promise<ArtifactSnapshot> => ({
    id: 'artifact1', organizationId: 'org1', projectId: 'project1', taskId: 'task1', runId: 'run1',
    kind: 'document', displayName: 'report.md', status: 'ready', mimeType: 'text/markdown', sizeBytes: 8,
    sha256: 'a'.repeat(64), sourceIds: [], previewAvailable: true, readyAt: '2026-08-12T00:00:00.000Z', createdAt: '2026-08-12T00:00:00.000Z'
  }));
}
