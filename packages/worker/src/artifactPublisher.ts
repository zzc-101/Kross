import { createHash } from 'node:crypto';

import type { RunSpec } from '@kross/protocol';
import { collectOutputArtifacts, type CollectedArtifact } from '@kross/work-runtime';

import type { WorkerControlTransport, WorkerLeaseIdentity } from './transport';

export async function publishOutputArtifacts(input: {
  runSpec: RunSpec;
  lease: WorkerLeaseIdentity;
  runToken: string;
  outputDirectory: string;
  transport: WorkerControlTransport;
  signal?: AbortSignal;
}): Promise<string[]> {
  const artifacts = await collectOutputArtifacts({
    outputDirectory: input.outputDirectory,
    maxTotalBytes: input.runSpec.resourceLimits.maxArtifactBytes,
    signal: input.signal
  });
  const artifactIds: string[] = [];
  for (const artifact of artifacts) {
    throwIfAborted(input.signal);
    const baseKey = stableKey(input.runSpec, artifact);
    const reservation = await retry(() => input.transport.reserveArtifact({
      lease: input.lease,
      runToken: input.runToken,
      artifact: {
        idempotencyKey: `reserve-${baseKey}`,
        taskId: input.runSpec.taskId,
        kind: artifact.kind,
        displayName: artifact.displayName,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        sourceIds: input.runSpec.sources.map((source) => source.id)
      }
    }), input.signal);
    if (reservation.alreadyCommitted) {
      artifactIds.push(reservation.artifactId);
      continue;
    }
    const uploaded = await retry(() => input.transport.uploadArtifact({
      upload: reservation.upload,
      absolutePath: artifact.absolutePath,
      signal: input.signal
    }), input.signal);
    const committed = await retry(() => input.transport.commitArtifact({
      lease: input.lease,
      runToken: input.runToken,
      commit: {
        idempotencyKey: `commit-${baseKey}`,
        artifactId: reservation.artifactId,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        ...(uploaded.etag ? { uploadEtag: uploaded.etag } : {})
      }
    }), input.signal);
    if (committed.id !== reservation.artifactId || committed.runId !== input.runSpec.runId || committed.status !== 'ready') {
      throw new Error('Committed Artifact response does not match the reservation');
    }
    artifactIds.push(committed.id);
  }
  return artifactIds;
}

function stableKey(runSpec: RunSpec, artifact: CollectedArtifact): string {
  return createHash('sha256')
    .update(`${runSpec.runId}\0${runSpec.generation}\0${artifact.relativePath}\0${artifact.sha256}`)
    .digest('hex');
}

async function retry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal);
    try { return await operation(); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : new Error('Operation aborted'));
}
