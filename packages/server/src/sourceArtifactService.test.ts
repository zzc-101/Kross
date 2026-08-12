import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { OrganizationContext } from '@kross/work-domain';

import { bufferIterable, HmacSignedBlobUrlProvider, MemoryBlobStore } from './blobStore';
import type { QueryResult, SqlClient, SqlExecutor, TransactionRunner } from './database';
import { SourceArtifactService } from './sourceArtifactService';

const context: OrganizationContext = {
  organizationId: 'org_a', userId: 'user_a', membershipId: 'member_a', role: 'member'
};
const signer = () => new HmacSignedBlobUrlProvider('a-secure-secret-that-is-at-least-32-bytes', 'https://control.example');

describe('SourceArtifactService', () => {
  it('creates an upload reservation and only finalizes verified content', async () => {
    const blobs = new MemoryBlobStore();
    let source: Record<string, unknown> | undefined;
    const sql = dynamicExecutor(async (statement, values) => {
      if (statement.includes('INSERT INTO sources')) {
        source = {
          id: values![0], organization_id: 'org_a', project_id: 'project_a', status: 'uploading',
          mime_type: 'text/plain', metadata: values![15]
        };
        return [source];
      }
      if (statement.includes('SELECT * FROM sources')) return source ? [source] : [];
      if (statement.includes('UPDATE sources')) {
        source = { ...source, status: 'ready', mime_type: values![2], size_bytes: values![3], sha256: values![4], blob_key: values![5] };
        return [source];
      }
      return [];
    });
    const service = new SourceArtifactService(sql, transactionRunner(sql), blobs, signer());
    const digest = createHash('sha256').update('hello').digest('hex');
    const created = await service.createUpload(context, {
      projectId: 'project_a', scope: 'project', displayName: 'notes.txt', mimeType: 'text/plain',
      sizeBytes: 5, sha256: digest
    });
    const upload = created.upload as { url: string };
    const claim = signer().verify(new URL(upload.url).pathname.split('/').at(-1)!, 'upload');
    await blobs.put(claim.blobKey, bufferIterable('hello'), { maxBytes: 5, expectedSizeBytes: 5, expectedSha256: digest });
    const ready = await service.completeUpload(context, String((created as Record<string, unknown>).id), { sizeBytes: 5, sha256: digest, mimeType: 'text/plain' });
    expect(ready).toMatchObject({ status: 'ready', size_bytes: 5, sha256: digest });
    expect(sql.query.mock.calls.some(([statement]) => String(statement).includes('organization_id = $1'))).toBe(true);
  });

  it('reserves and commits an Artifact idempotently without putting bytes in SQL', async () => {
    const blobs = new MemoryBlobStore();
    let artifact: Record<string, unknown> | undefined;
    const sql = dynamicExecutor(async (statement, values) => {
      if (statement.includes('SELECT * FROM artifacts') && statement.includes('reserve_idempotency_key')) return artifact ? [artifact] : [];
      if (statement.includes('INSERT INTO artifacts')) {
        artifact = {
          id: values![0], organization_id: 'org_a', project_id: 'project_a', task_id: 'task_a', run_id: 'run_a',
          kind: values![4], status: 'pending', display_name: values![5], file_name: values![5], mime_type: values![6],
          size_bytes: values![7], sha256: values![8], previous_artifact_id: values![9], metadata: values![10],
          generation: values![11], reserve_idempotency_key: values![12], upload_blob_key: values![13],
          created_at: new Date('2026-08-12T00:00:00Z')
        };
        return [artifact];
      }
      if (statement.includes('SELECT * FROM artifacts') && statement.includes('FOR UPDATE')) return artifact ? [artifact] : [];
      if (statement.includes('UPDATE artifacts SET status')) {
        artifact = { ...artifact, status: 'ready', blob_key: values![3], upload_blob_key: null, ready_at: new Date('2026-08-12T00:01:00Z') };
        return [artifact];
      }
      return [];
    });
    const service = new SourceArtifactService(sql, transactionRunner(sql), blobs, signer(), {
      now: () => new Date(Date.now() + 60_000)
    });
    const digest = createHash('sha256').update('report').digest('hex');
    const message = {
      protocolVersion: 2 as const, type: 'artifact.reserve' as const, messageId: 'message_a',
      sentAt: '2026-08-12T00:00:00Z', idempotencyKey: 'reserve_a', runId: 'run_a', generation: 2,
      taskId: 'task_a', kind: 'document' as const, displayName: 'report.md', mimeType: 'text/markdown',
      sizeBytes: 6, sha256: digest, sourceIds: ['source_a']
    };
    const reserved = await service.reserveArtifact(context, 2, message);
    const repeated = await service.reserveArtifact(context, 2, message);
    expect(repeated.artifactId).toBe(reserved.artifactId);
    if (reserved.alreadyCommitted || !('upload' in reserved)) throw new Error('Expected upload reservation');
    const upload = reserved.upload;
    const claim = signer().verify(new URL(upload.url).pathname.split('/').at(-1)!, 'upload');
    await blobs.put(claim.blobKey, bufferIterable('report'), { maxBytes: 6, expectedSizeBytes: 6, expectedSha256: digest });
    const committed = await service.commitArtifact(context, 2, {
      protocolVersion: 2, type: 'artifact.commit', messageId: 'message_b', sentAt: '2026-08-12T00:01:00Z',
      idempotencyKey: 'reserve_a', runId: 'run_a', generation: 2, artifactId: String(reserved.artifactId),
      sizeBytes: 6, sha256: digest
    });
    expect(committed.artifact).toMatchObject({ status: 'ready', sha256: digest, sizeBytes: 6 });
  });
});

function dynamicExecutor(handler: (statement: string, values: readonly unknown[] | undefined) => Promise<Record<string, unknown>[]>) {
  const query = vi.fn(async (statement: string, values?: readonly unknown[]): Promise<QueryResult> => {
    const rows = await handler(statement, values); return { rows, rowCount: rows.length };
  });
  return { query } as SqlExecutor & { query: typeof query };
}
function transactionRunner(sql: SqlExecutor): TransactionRunner {
  return { transaction: async <T>(operation: (client: SqlClient) => Promise<T>) => operation(sql as SqlClient) };
}
