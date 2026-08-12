import type {
  InternalWorkerMessage,
  RunSpec,
  WorkerRunEventEnvelope
} from '@kross/protocol';
import { runSpecSchema } from '@kross/protocol';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { OrganizationContext } from '@kross/work-domain';

import type { SqlExecutor, TransactionRunner } from './database';
import { conflict, notFound, ServerError } from './errors';
import { PostgresLeaseQueue, type RunLease } from './leaseQueue';

export type WorkerRegisterRequest = Extract<InternalWorkerMessage, { type: 'worker.register' }>;
export type WorkerHeartbeatRequest = Extract<InternalWorkerMessage, { type: 'worker.heartbeat' }>;
export type WorkerReleaseRequest = Extract<InternalWorkerMessage, { type: 'lease.release' }>;

export interface WorkerRegisteredResponse {
  readonly type: 'worker.registered';
  readonly protocolVersion: 2;
  readonly messageId: string;
  readonly sentAt: string;
  readonly workerSessionId: string;
  readonly heartbeatIntervalMs: number;
  readonly runSpec: RunSpec;
}

export interface WorkerEventAckResponse {
  readonly type: 'worker.event_ack';
  readonly protocolVersion: 2;
  readonly messageId: string;
  readonly sentAt: string;
  readonly runId: string;
  readonly generation: number;
  readonly acceptedThroughSeq: number;
}

export interface LeaseRenewedResponse {
  readonly type: 'lease.renewed';
  readonly protocolVersion: 2;
  readonly messageId: string;
  readonly sentAt: string;
  readonly workerSessionId: string;
  readonly runId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
}

/**
 * Trust boundary for run-scoped Worker traffic. Implementations must hash tokens at rest and bind
 * them to runId, generation, leaseId and expiry before carrying out any operation.
 */
export interface WorkerControlService {
  register(token: string, message: WorkerRegisterRequest): Promise<WorkerRegisteredResponse>;
  appendEvent(token: string, envelope: WorkerRunEventEnvelope): Promise<WorkerEventAckResponse>;
  heartbeat(token: string, message: WorkerHeartbeatRequest): Promise<LeaseRenewedResponse>;
  release(token: string, message: WorkerReleaseRequest): Promise<void>;
}

export interface IssuedRunToken {
  /** Bearer secret. It is returned once and is never persisted by the control plane. */
  readonly token: string;
  readonly expiresAt: string;
}

interface TokenBinding {
  readonly tokenHash: string;
  readonly organizationId: string;
  readonly runId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly leaseOwner: string;
  readonly expiresAt: string;
  readonly workerSessionId?: string;
  readonly workerId?: string;
}

export interface PostgresWorkerControlOptions {
  readonly heartbeatIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
}

/** PostgreSQL-backed implementation of the run-scoped Worker trust boundary. */
export class PostgresWorkerControlService implements WorkerControlService {
  private readonly heartbeatIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;
  private readonly leases: PostgresLeaseQueue;

  public constructor(
    private readonly sql: SqlExecutor,
    private readonly transactions: TransactionRunner,
    options: PostgresWorkerControlOptions = {}
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
    this.leases = new PostgresLeaseQueue(transactions);
  }

  /** Issues a new secret for an already-claimed lease. Only its SHA-256 digest is persisted. */
  public async issueRunToken(lease: RunLease, ttlMs = this.leaseDurationMs): Promise<IssuedRunToken> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const requestedExpiry = new Date(this.now().getTime() + ttlMs);
    const expiresAt = new Date(Math.min(requestedExpiry.getTime(), Date.parse(lease.expiresAt)));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= this.now()) {
      throw conflict('lease_expired', 'Cannot issue a token for an expired lease');
    }
    const result = await this.sql.query(
      `INSERT INTO worker_run_tokens
       (token_hash, organization_id, run_id, generation, lease_id, expires_at)
       SELECT $1, l.organization_id, l.run_id, l.generation, l.lease_id, $6
       FROM run_leases l
       WHERE l.organization_id = $2 AND l.run_id = $3 AND l.generation = $4
         AND l.lease_id = $5 AND l.status = 'leased' AND l.lease_expires_at > now()
       RETURNING expires_at`,
      [tokenHash, lease.organizationId, lease.runId, lease.generation, lease.leaseId, expiresAt.toISOString()]
    );
    if (!result.rows[0]) throw conflict('lease_lost', 'Lease is no longer active');
    return { token, expiresAt: iso(result.rows[0].expires_at) };
  }

  public async register(token: string, message: WorkerRegisterRequest): Promise<WorkerRegisteredResponse> {
    const binding = await this.authenticate(token);
    assertBinding(binding, message.runId, message.generation, message.leaseId);
    if (binding.workerId && binding.workerId !== message.workerId) {
      throw new ServerError('worker_token_mismatch', 'Token is already bound to another Worker', 401);
    }
    const workerSessionId = binding.workerSessionId ?? randomUUID();
    const registered = await this.sql.query(
      `UPDATE worker_run_tokens SET worker_session_id = $2, worker_id = $3, registered_at = COALESCE(registered_at, now())
       WHERE token_hash = $1 AND revoked_at IS NULL
         AND (worker_session_id IS NULL OR worker_session_id = $2)
         AND (worker_id IS NULL OR worker_id = $3)
       RETURNING worker_session_id`,
      [binding.tokenHash, workerSessionId, message.workerId]
    );
    if (!registered.rows[0]) throw conflict('worker_registration_conflict', 'Worker registration raced or token was revoked');
    const runSpec = await this.loadRunSpec(binding);
    return {
      type: 'worker.registered', protocolVersion: 2, messageId: randomUUID(),
      sentAt: this.now().toISOString(), workerSessionId, heartbeatIntervalMs: this.heartbeatIntervalMs,
      runSpec
    };
  }

  public async appendEvent(token: string, envelope: WorkerRunEventEnvelope): Promise<WorkerEventAckResponse> {
    const binding = await this.authenticate(token, true);
    assertBinding(binding, envelope.runId, envelope.generation);
    const result = await this.sql.query(
      `WITH target AS (
         SELECT r.organization_id, r.project_id, r.task_id, r.id
         FROM runs r JOIN run_leases l ON l.organization_id = r.organization_id AND l.run_id = r.id
         WHERE r.organization_id = $1 AND r.id = $2 AND l.generation = $3
           AND l.lease_id = $4 AND l.status = 'leased' AND l.lease_expires_at > now()
       ), inserted AS (
         INSERT INTO run_events
           (public_event_id, organization_id, project_id, task_id, run_id, generation, seq, type, occurred_at, payload)
         SELECT $5, organization_id, project_id, task_id, id, $3, $6, $7, $8, $9 FROM target
         ON CONFLICT (run_id, generation, seq) DO NOTHING
         RETURNING seq
       )
       SELECT COALESCE(MAX(seq), 0)::bigint AS accepted_through_seq
       FROM run_events WHERE run_id = $2 AND generation = $3`,
      [binding.organizationId, binding.runId, binding.generation, binding.leaseId, randomUUID(),
        envelope.seq, envelope.event.type, envelope.timestamp, envelope.event]
    );
    const acceptedThroughSeq = Number(result.rows[0]?.accepted_through_seq ?? 0);
    if (acceptedThroughSeq === 0) throw conflict('worker_event_rejected', 'Run lease is no longer active');
    return {
      type: 'worker.event_ack', protocolVersion: 2, messageId: randomUUID(), sentAt: this.now().toISOString(),
      runId: binding.runId, generation: binding.generation, acceptedThroughSeq
    };
  }

  public async heartbeat(token: string, message: WorkerHeartbeatRequest): Promise<LeaseRenewedResponse> {
    const binding = await this.authenticate(token, true);
    assertBinding(binding, message.runId, message.generation, message.leaseId, message.workerSessionId);
    const lease = await this.leases.renew(
      workerContext(binding), binding.leaseId, binding.leaseOwner, binding.generation, this.leaseDurationMs
    );
    await this.sql.query(
      `UPDATE worker_run_tokens SET expires_at = LEAST($2::timestamptz, now() + ($3 * interval '1 millisecond'))
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [binding.tokenHash, lease.expiresAt, this.leaseDurationMs]
    );
    return {
      type: 'lease.renewed', protocolVersion: 2, messageId: randomUUID(), sentAt: this.now().toISOString(),
      workerSessionId: message.workerSessionId, runId: binding.runId, generation: binding.generation,
      leaseId: binding.leaseId, leaseExpiresAt: lease.expiresAt
    };
  }

  public async release(token: string, message: WorkerReleaseRequest): Promise<void> {
    const binding = await this.authenticate(token, true);
    assertBinding(binding, message.runId, message.generation, message.leaseId, message.workerSessionId);
    await this.transactions.transaction(async (client) => {
      const released = await client.query(
        `UPDATE run_leases SET status = 'released', available_at = now(), lease_id = NULL,
            lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE organization_id = $1 AND run_id = $2 AND lease_id = $3 AND generation = $4
           AND lease_owner = $5 AND status = 'leased'`,
        [binding.organizationId, binding.runId, binding.leaseId, binding.generation, binding.leaseOwner]
      );
      if (released.rowCount !== 1) throw notFound('Lease');
      await client.query(
        `UPDATE worker_run_tokens SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL`, [binding.tokenHash]
      );
    });
  }

  private async authenticate(token: string, requireSession = false): Promise<TokenBinding> {
    const calculated = hashToken(token);
    const result = await this.sql.query(
      `SELECT t.token_hash, t.organization_id, t.run_id, t.generation, t.lease_id,
              t.expires_at, t.worker_session_id, t.worker_id, l.lease_owner
       FROM worker_run_tokens t
       JOIN run_leases l ON l.organization_id = t.organization_id AND l.run_id = t.run_id
       WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now()
         AND l.generation = t.generation AND l.lease_id = t.lease_id
         AND l.status = 'leased' AND l.lease_expires_at > now()`, [calculated]
    );
    const row = result.rows[0];
    if (!row || !safeHashEqual(calculated, String(row.token_hash))) {
      throw new ServerError('worker_unauthenticated', 'Invalid or expired run-scoped token', 401);
    }
    const binding: TokenBinding = {
      tokenHash: String(row.token_hash), organizationId: String(row.organization_id), runId: String(row.run_id),
      generation: Number(row.generation), leaseId: String(row.lease_id), leaseOwner: String(row.lease_owner),
      expiresAt: iso(row.expires_at),
      ...(row.worker_session_id == null ? {} : { workerSessionId: String(row.worker_session_id) }),
      ...(row.worker_id == null ? {} : { workerId: String(row.worker_id) })
    };
    if (requireSession && !binding.workerSessionId) {
      throw new ServerError('worker_not_registered', 'Worker must register before using this token', 401);
    }
    return binding;
  }

  private async loadRunSpec(binding: TokenBinding): Promise<RunSpec> {
    const result = await this.sql.query(
      `SELECT r.*, t.type AS task_type, t.title AS task_title, t.objective AS task_objective,
              t.constraints AS task_constraints, t.acceptance_criteria AS task_acceptance_criteria,
              p.repository_binding, l.lease_expires_at,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'id', m.id, 'role', m.role, 'content', m.content, 'created_at', m.created_at
              ) ORDER BY m.created_at, m.id) FROM task_messages m
                WHERE m.organization_id = r.organization_id AND m.task_id = r.task_id), '[]'::jsonb) AS messages
       FROM runs r
       JOIN tasks t ON t.organization_id = r.organization_id AND t.id = r.task_id
       JOIN projects p ON p.organization_id = r.organization_id AND p.id = r.project_id
       JOIN run_leases l ON l.organization_id = r.organization_id AND l.run_id = r.id
       WHERE r.organization_id = $1 AND r.id = $2 AND l.generation = $3 AND l.lease_id = $4
         AND l.status = 'leased' AND l.lease_expires_at > now()`,
      [binding.organizationId, binding.runId, binding.generation, binding.leaseId]
    );
    const row = result.rows[0];
    if (!row) throw notFound('Run');
    const permission = asObject(row.permission_policy);
    const model = asObject(row.model_snapshot);
    const repository = row.repository_binding == null ? undefined : asObject(row.repository_binding);
    const messages = Array.isArray(row.messages) ? row.messages : [];
    return runSpecSchema.parse({
      protocolVersion: 2,
      organizationId: binding.organizationId, projectId: String(row.project_id), taskId: String(row.task_id),
      runId: binding.runId, generation: binding.generation, leaseId: binding.leaseId,
      leaseExpiresAt: iso(row.lease_expires_at), issuedAt: this.now().toISOString(),
      task: {
        type: row.task_type, title: row.task_title, objective: row.task_objective,
        constraints: row.task_constraints, acceptanceCriteria: row.task_acceptance_criteria,
        messages: messages.map(mapRunSpecMessage)
      },
      sources: [],
      ...(repository === undefined ? {} : { repository }),
      model,
      mode: row.mode, executionProfile: row.execution_profile,
      policy: {
        permissionPolicy: permission,
        allowedToolNames: stringArray(permission.allowedToolNames),
        connectorInstallationIds: stringArray(permission.connectorInstallationIds),
        externalActions: permission.externalActions ?? 'require_approval',
        networkAccess: permission.networkAccess ?? (permission.allowNetworkAccess === true ? 'restricted' : 'disabled')
      },
      resourceLimits: row.resource_limits,
      workspace: {
        root: '/work', inputDirectory: '/work/input', outputDirectory: '/work/output',
        checkpointDirectory: '/work/checkpoint',
        ...(repository === undefined ? {} : { repositoryDirectory: '/work/repository' })
      },
      ...(row.checkpoint_key == null ? {} : { resumeCheckpointKey: String(row.checkpoint_key) })
    });
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function assertBinding(
  binding: TokenBinding,
  runId: string,
  generation: number,
  leaseId?: string,
  workerSessionId?: string
): void {
  if (binding.runId !== runId || binding.generation !== generation ||
      (leaseId !== undefined && binding.leaseId !== leaseId) ||
      (workerSessionId !== undefined && binding.workerSessionId !== workerSessionId)) {
    throw new ServerError('worker_token_mismatch', 'Message does not match the run-scoped token binding', 401);
  }
}

function workerContext(binding: TokenBinding): OrganizationContext {
  return {
    organizationId: binding.organizationId,
    userId: 'worker-control',
    membershipId: 'worker-control',
    role: 'admin'
  };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function mapRunSpecMessage(value: unknown): Record<string, unknown> {
  const message = asObject(value);
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks.map(asObject).filter((block) => block.type === 'text')
    .map((block) => String(block.text ?? '')).filter(Boolean).join('\n');
  return { id: String(message.id), role: message.role, text, createdAt: iso(message.created_at) };
}
