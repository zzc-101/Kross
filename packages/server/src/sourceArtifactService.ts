import { createHash, randomUUID } from 'node:crypto';

import type { ArtifactCommitMessage, ArtifactReserveMessage } from '@kross/protocol';
import type { OrganizationContext } from '@kross/work-domain';

import type { BlobStore, SignedBlobUrlProvider } from './blobStore';
import { bufferIterable } from './blobStore';
import type { SqlExecutor, TransactionRunner } from './database';
import { conflict, notFound, ServerError } from './errors';

const DEFAULT_MAX_BYTES = 104_857_600;
const URL_TTL_MS = 15 * 60_000;

export interface SourceUploadCommand {
  readonly projectId: string;
  readonly scope: 'project' | 'task';
  readonly taskId?: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly previousSourceId?: string;
}

export interface InlineSourceCommand {
  readonly projectId: string;
  readonly scope: 'project' | 'task';
  readonly taskId?: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly content: string;
  readonly previousSourceId?: string;
}

export interface ExternalSourceCommand {
  readonly projectId: string;
  readonly kind: 'url' | 'repository';
  readonly scope: 'project' | 'task';
  readonly taskId?: string;
  readonly displayName: string;
  readonly locator: string;
  readonly previousSourceId?: string;
  readonly origin: Readonly<Record<string, unknown>>;
}

export interface SourceArtifactOptions {
  readonly maxSourceBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly now?: () => Date;
}

export class SourceArtifactService {
  private readonly maxSourceBytes: number;
  private readonly maxArtifactBytes: number;
  private readonly now: () => Date;

  public constructor(
    private readonly sql: SqlExecutor,
    private readonly transactions: TransactionRunner,
    private readonly blobs: BlobStore,
    private readonly signedUrls: SignedBlobUrlProvider,
    options: SourceArtifactOptions = {}
  ) {
    this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_BYTES;
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  public async createUpload(context: OrganizationContext, command: SourceUploadCommand) {
    assertRequestedSize(command.sizeBytes, this.maxSourceBytes);
    const sourceId = randomUUID();
    const stagingKey = `staging/sources/${context.organizationId}/${sourceId}`;
    const metadata = {
      stagingBlobKey: stagingKey,
      expectedMimeType: normalizeMime(command.mimeType),
      ...(command.sizeBytes === undefined ? {} : { expectedSizeBytes: command.sizeBytes }),
      ...(command.sha256 === undefined ? {} : { expectedSha256: command.sha256 })
    };
    const row = await this.insertSource(context, sourceId, command, 'upload', 'uploading', null,
      { kind: 'upload', originalFileName: command.displayName }, metadata);
    const expiresAt = new Date(this.now().getTime() + URL_TTL_MS).toISOString();
    return {
      ...row,
      upload: {
        method: 'PUT',
        url: this.signedUrls.createUploadUrl({
          blobKey: stagingKey, expiresAt, maxBytes: this.maxSourceBytes,
          mimeType: normalizeMime(command.mimeType),
          ...(command.sizeBytes === undefined ? {} : { sizeBytes: command.sizeBytes }),
          ...(command.sha256 === undefined ? {} : { sha256: command.sha256 })
        }),
        headers: [{ name: 'content-type', value: normalizeMime(command.mimeType) }],
        expiresAt
      }
    };
  }

  public async createInline(context: OrganizationContext, command: InlineSourceCommand) {
    const bytes = Buffer.from(command.content, 'utf8');
    assertRequestedSize(bytes.byteLength, this.maxSourceBytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const blobKey = `sha256/${sha256.slice(0, 2)}/${sha256}`;
    if (!await this.blobs.stat(blobKey)) {
      await this.blobs.put(blobKey, bufferIterable(bytes), {
        maxBytes: this.maxSourceBytes, expectedSizeBytes: bytes.byteLength, expectedSha256: sha256
      });
    }
    return this.insertSource(context, randomUUID(), command, 'generated', 'ready', null,
      { kind: 'generated', runId: 'inline-source' }, {}, { sizeBytes: bytes.byteLength, sha256, blobKey });
  }

  /** URL and repository references remain processing until an isolated ingestion Worker finalizes them. */
  public async createExternal(context: OrganizationContext, command: ExternalSourceCommand) {
    if (command.kind === 'url') {
      const url = new URL(command.locator);
      if (url.protocol !== 'https:') throw new ServerError('unsafe_source_url', 'Only HTTPS Source URLs are accepted', 400);
    }
    return this.insertSource(context, randomUUID(), command, command.kind, 'processing', command.locator,
      command.origin, { ingestionRequired: true });
  }

  public async completeUpload(
    context: OrganizationContext,
    sourceId: string,
    input: { readonly sizeBytes: number; readonly sha256: string; readonly mimeType: string }
  ) {
    assertRequestedSize(input.sizeBytes, this.maxSourceBytes);
    return this.transactions.transaction(async (client) => {
      const locked = await client.query(
        `SELECT * FROM sources WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [context.organizationId, sourceId]
      );
      const source = locked.rows[0];
      if (!source) throw notFound('Source');
      if (source.status === 'ready') {
        if (Number(source.size_bytes) === input.sizeBytes && source.sha256 === input.sha256 &&
            normalizeMime(String(source.mime_type)) === normalizeMime(input.mimeType)) return source;
        throw conflict('source_already_finalized', 'Source was finalized with different content');
      }
      if (source.status !== 'uploading') throw conflict('source_not_uploading', 'Source is not awaiting upload completion');
      const metadata = asObject(source.metadata);
      const stagingKey = String(metadata.stagingBlobKey ?? '');
      if (!stagingKey) throw conflict('source_upload_missing', 'Source has no pending upload');
      if (normalizeMime(String(metadata.expectedMimeType)) !== normalizeMime(input.mimeType)) {
        throw new ServerError('blob_mime_mismatch', 'Uploaded MIME type does not match', 422);
      }
      if (metadata.expectedSizeBytes !== undefined && Number(metadata.expectedSizeBytes) !== input.sizeBytes) {
        throw new ServerError('blob_size_mismatch', 'Uploaded size does not match reservation', 422);
      }
      if (metadata.expectedSha256 !== undefined && metadata.expectedSha256 !== input.sha256) {
        throw new ServerError('blob_hash_mismatch', 'Uploaded hash does not match reservation', 422);
      }
      const uploaded = await this.blobs.stat(stagingKey);
      if (!uploaded) throw new ServerError('blob_not_found', 'Uploaded blob not found', 404);
      if (uploaded.sizeBytes !== input.sizeBytes) throw new ServerError('blob_size_mismatch', 'Uploaded size does not match', 422);
      if (uploaded.sha256 !== input.sha256) throw new ServerError('blob_hash_mismatch', 'Uploaded hash does not match', 422);
      const promoted = await this.blobs.promote(stagingKey, input.sha256);
      const updated = await client.query(
        `UPDATE sources SET status = 'ready', mime_type = $3, size_bytes = $4, sha256 = $5,
            blob_key = $6, metadata = metadata - 'stagingBlobKey'
         WHERE organization_id = $1 AND id = $2 AND status = 'uploading' RETURNING *`,
        [context.organizationId, sourceId, normalizeMime(input.mimeType), input.sizeBytes, input.sha256, promoted.key]
      );
      if (!updated.rows[0]) throw conflict('source_finalize_race', 'Source finalization raced');
      return updated.rows[0];
    });
  }

  public async reserveArtifact(context: OrganizationContext, generation: number, message: ArtifactReserveMessage) {
    assertRequestedSize(message.sizeBytes, this.maxArtifactBytes);
    const existing = await this.sql.query(
      `SELECT * FROM artifacts WHERE organization_id = $1 AND run_id = $2 AND reserve_idempotency_key = $3`,
      [context.organizationId, message.runId, message.idempotencyKey]
    );
    let row = existing.rows[0];
    if (row) assertArtifactReservation(row, generation, message);
    if (!row) {
      const artifactId = randomUUID();
      const stagingKey = `staging/artifacts/${context.organizationId}/${artifactId}`;
      const inserted = await this.sql.query(
        `INSERT INTO artifacts
         (id, organization_id, project_id, task_id, run_id, kind, status, display_name, file_name,
          mime_type, size_bytes, sha256, previous_artifact_id, metadata, generation,
          reserve_idempotency_key, upload_blob_key)
         SELECT $1, r.organization_id, r.project_id, r.task_id, r.id, $5, 'pending', $6, $6,
                $7, $8, $9, $10, $11, $12, $13, $14
         FROM runs r WHERE r.organization_id = $2 AND r.id = $3 AND r.task_id = $4
         RETURNING *`,
        [artifactId, context.organizationId, message.runId, message.taskId, message.kind,
          message.displayName, normalizeMime(message.mimeType), message.sizeBytes, message.sha256,
          message.parentArtifactId ?? null, { sourceIds: message.sourceIds }, generation,
          message.idempotencyKey, stagingKey]
      );
      row = inserted.rows[0];
      if (!row) throw notFound('Run');
    }
    if (row.status === 'ready') return this.artifactReserved(message, row, generation, true);
    if (row.status !== 'pending') throw conflict('artifact_not_pending', 'Artifact cannot be uploaded in its current state');
    return this.artifactReserved(message, row, generation, false);
  }

  public async commitArtifact(context: OrganizationContext, generation: number, message: ArtifactCommitMessage) {
    return this.transactions.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM artifacts WHERE organization_id = $1 AND run_id = $2 AND id = $3 FOR UPDATE`,
        [context.organizationId, message.runId, message.artifactId]
      );
      const row = selected.rows[0];
      if (!row) throw notFound('Artifact');
      if (row.reserve_idempotency_key !== message.idempotencyKey || Number(row.generation) !== generation) {
        throw conflict('artifact_commit_mismatch', 'Artifact commit does not match its reservation');
      }
      if (Number(row.size_bytes) !== message.sizeBytes || row.sha256 !== message.sha256) {
        throw new ServerError('artifact_content_mismatch', 'Artifact content does not match its reservation', 422);
      }
      if (row.status === 'ready') return mapCommittedArtifact(row, message, generation, this.now);
      if (row.status !== 'pending') throw conflict('artifact_not_pending', 'Artifact cannot be committed in its current state');
      const stagingKey = String(row.upload_blob_key);
      const blob = await this.blobs.stat(stagingKey);
      if (!blob) throw new ServerError('blob_not_found', 'Artifact upload not found', 404);
      if (blob.sizeBytes !== message.sizeBytes) throw new ServerError('blob_size_mismatch', 'Artifact size does not match', 422);
      if (blob.sha256 !== message.sha256) throw new ServerError('blob_hash_mismatch', 'Artifact hash does not match', 422);
      const promoted = await this.blobs.promote(stagingKey, message.sha256);
      const updated = await client.query(
        `UPDATE artifacts SET status = 'ready', blob_key = $4, upload_blob_key = NULL,
            ready_at = now(), metadata = metadata || $5::jsonb
         WHERE organization_id = $1 AND run_id = $2 AND id = $3 AND status = 'pending' RETURNING *`,
        [context.organizationId, message.runId, message.artifactId, promoted.key,
          message.uploadEtag === undefined ? {} : { uploadEtag: message.uploadEtag }]
      );
      if (!updated.rows[0]) throw conflict('artifact_commit_race', 'Artifact commit raced');
      return mapCommittedArtifact(updated.rows[0], message, generation, this.now);
    });
  }

  public createDownloadUrl(blobKey: string, ttlMs = URL_TTL_MS): string {
    return this.signedUrls.createDownloadUrl({ blobKey, expiresAt: new Date(this.now().getTime() + ttlMs).toISOString() });
  }

  private async insertSource(
    context: OrganizationContext, id: string,
    command: { projectId: string; scope: 'project' | 'task'; taskId?: string; displayName: string; mimeType?: string; previousSourceId?: string },
    kind: string, status: string, externalLocator: string | null,
    origin: Readonly<Record<string, unknown>>, metadata: Readonly<Record<string, unknown>>,
    ready: { sizeBytes: number; sha256: string; blobKey: string } | undefined = undefined
  ) {
    if ((command.scope === 'task') !== (command.taskId !== undefined)) throw new ServerError('invalid_source_scope', 'Task Source requires taskId', 400);
    const result = await this.sql.query(
      `INSERT INTO sources
       (id, organization_id, project_id, task_id, kind, scope, status, display_name, mime_type,
        size_bytes, sha256, blob_key, external_locator, origin, previous_source_id, metadata, created_by)
       SELECT $1, p.organization_id, p.id, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
       FROM projects p
       WHERE p.organization_id = $2 AND p.id = $3
         AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM tasks t
           WHERE t.organization_id = p.organization_id AND t.project_id = p.id AND t.id = $4))
         AND ($15::text IS NULL OR EXISTS (SELECT 1 FROM sources previous
           WHERE previous.organization_id = p.organization_id AND previous.project_id = p.id AND previous.id = $15))
       RETURNING *`,
      [id, context.organizationId, command.projectId, command.taskId ?? null, kind, command.scope, status,
        command.displayName, command.mimeType === undefined ? null : normalizeMime(command.mimeType),
        ready?.sizeBytes ?? null, ready?.sha256 ?? null, ready?.blobKey ?? null, externalLocator,
        origin, command.previousSourceId ?? null, metadata, context.userId]
    );
    if (!result.rows[0]) throw notFound('Project or Source parent');
    return result.rows[0];
  }

  private artifactReserved(message: ArtifactReserveMessage, row: Record<string, unknown>, generation: number, committed: boolean) {
    const base = {
      protocolVersion: 2 as const, type: 'artifact.reserved' as const, messageId: randomUUID(),
      sentAt: this.now().toISOString(), idempotencyKey: message.idempotencyKey,
      runId: message.runId, generation, artifactId: String(row.id), alreadyCommitted: committed
    };
    if (committed) return base;
    const expiresAt = new Date(this.now().getTime() + URL_TTL_MS).toISOString();
    return {
      ...base, alreadyCommitted: false as const,
      upload: {
        method: 'PUT' as const,
        url: this.signedUrls.createUploadUrl({
          blobKey: String(row.upload_blob_key), expiresAt, maxBytes: this.maxArtifactBytes,
          sizeBytes: Number(row.size_bytes), sha256: String(row.sha256), mimeType: String(row.mime_type)
        }),
        headers: [{ name: 'content-type', value: String(row.mime_type) }], expiresAt
      }
    };
  }
}

function mapCommittedArtifact(row: Record<string, unknown>, request: ArtifactCommitMessage, generation: number, now: () => Date) {
  const metadata = asObject(row.metadata);
  return {
    protocolVersion: 2 as const, type: 'artifact.committed' as const, messageId: randomUUID(),
    sentAt: now().toISOString(), idempotencyKey: request.idempotencyKey,
    runId: request.runId, generation,
    artifact: {
      id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
      taskId: String(row.task_id), kind: row.kind, status: 'ready' as const,
      displayName: String(row.display_name), mimeType: String(row.mime_type), sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256), sourceIds: Array.isArray(metadata.sourceIds) ? metadata.sourceIds : [],
      previewAvailable: metadata.previewBlobKey !== undefined,
      downloadPath: `/api/v2/artifacts/${String(row.id)}/content`,
      readyAt: row.ready_at instanceof Date ? row.ready_at.toISOString() : String(row.ready_at ?? now().toISOString()),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      ...(row.previous_artifact_id == null ? {} : { parentArtifactId: String(row.previous_artifact_id) })
    }
  };
}

function assertArtifactReservation(row: Record<string, unknown>, generation: number, message: ArtifactReserveMessage): void {
  const metadata = asObject(row.metadata);
  const same = Number(row.generation) === generation && row.task_id === message.taskId && row.kind === message.kind &&
    row.display_name === message.displayName && normalizeMime(String(row.mime_type)) === normalizeMime(message.mimeType) &&
    Number(row.size_bytes) === message.sizeBytes && row.sha256 === message.sha256 &&
    (row.previous_artifact_id ?? undefined) === message.parentArtifactId &&
    JSON.stringify(metadata.sourceIds ?? []) === JSON.stringify(message.sourceIds);
  if (!same) throw conflict('artifact_idempotency_conflict', 'Artifact idempotency key was used for another reservation');
}

function assertRequestedSize(sizeBytes: number | undefined, maximum: number): void {
  if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > maximum)) {
    throw new ServerError('blob_too_large', 'Blob exceeds its size limit', 413);
  }
}
function normalizeMime(value: string): string {
  const normalized = value.split(';', 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) {
    throw new ServerError('invalid_mime_type', 'Invalid MIME type', 400);
  }
  return normalized;
}
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
