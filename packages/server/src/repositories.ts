import { randomUUID } from 'node:crypto';

import type {
  AppendRunEventInput,
  Membership,
  MembershipRole,
  OrganizationContext,
  RunStatus,
  TaskType
} from '@kross/work-domain';

import type { SqlExecutor, TransactionRunner } from './database';
import { conflict, notFound } from './errors';

export interface ProjectRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: 'general' | 'repository';
  readonly name: string;
  readonly description?: string;
  readonly status: 'active' | 'archived' | 'deleted';
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly type: TaskType;
  readonly title: string;
  readonly objective: string;
  readonly constraints: string[];
  readonly acceptanceCriteria: string[];
  readonly status: 'open' | 'completed' | 'cancelled' | 'archived';
  readonly latestRunId?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly status: RunStatus;
  readonly mode: 'auto' | 'plan';
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly createdBy: string;
}

export interface RunEventRecord {
  readonly eventId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly generation: number;
  readonly seq: number;
  readonly type: string;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CreateProjectCommand {
  readonly kind: 'general' | 'repository';
  readonly name: string;
  readonly description?: string;
  readonly repository?: Readonly<Record<string, unknown>>;
  readonly defaultTaskType?: TaskType;
}

export interface CreateTaskCommand {
  readonly projectId: string;
  readonly type: TaskType;
  readonly title: string;
  readonly objective: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
}

export interface CreateRunCommand {
  readonly taskId: string;
  readonly mode: 'auto' | 'plan';
  readonly selectedSourceIds?: readonly string[];
  readonly requestedModelProfileId?: string;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function optionalIso(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : iso(value);
}

function mapProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id), organizationId: String(row.organization_id),
    kind: row.kind as ProjectRecord['kind'], name: String(row.name),
    ...(row.description == null ? {} : { description: String(row.description) }),
    status: row.status as ProjectRecord['status'], createdBy: String(row.created_by),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    type: row.type as TaskType, title: String(row.title), objective: String(row.objective),
    constraints: row.constraints as string[], acceptanceCriteria: row.acceptance_criteria as string[],
    status: row.status as TaskRecord['status'],
    ...(row.latest_run_id == null ? {} : { latestRunId: String(row.latest_run_id) }),
    createdBy: String(row.created_by), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    taskId: String(row.task_id), attempt: Number(row.attempt), status: row.status as RunStatus,
    mode: row.mode as RunRecord['mode'], queuedAt: iso(row.queued_at),
    ...(optionalIso(row.started_at) === undefined ? {} : { startedAt: optionalIso(row.started_at) }),
    ...(optionalIso(row.finished_at) === undefined ? {} : { finishedAt: optionalIso(row.finished_at) }),
    createdBy: String(row.created_by)
  };
}

export class MembershipRepository {
  public constructor(private readonly sql: SqlExecutor) {}

  public async findActive(organizationId: string, userId: string): Promise<Membership | undefined> {
    const result = await this.sql.query(
      `SELECT id, organization_id, user_id, role, status, created_at, updated_at
       FROM organization_memberships
       WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`,
      [organizationId, userId]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: String(row.id), organizationId: String(row.organization_id), userId: String(row.user_id),
      role: row.role as MembershipRole, status: 'active', createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  public async listForUser(userId: string): Promise<Membership[]> {
    const result = await this.sql.query(
      `SELECT id, organization_id, user_id, role, status, created_at, updated_at
       FROM organization_memberships WHERE user_id = $1 AND status = 'active'`, [userId]
    );
    return result.rows.map((row) => ({
      id: String(row.id), organizationId: String(row.organization_id), userId: String(row.user_id),
      role: row.role as MembershipRole, status: 'active' as const, createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    }));
  }
}

export class OrganizationRepository {
  public constructor(private readonly sql: SqlExecutor) {}

  public async get(context: OrganizationContext): Promise<Record<string, unknown>> {
    const result = await this.sql.query(
      `SELECT id, slug, name, status, default_timezone, data_retention_days,
              approval_policy, created_at, updated_at
       FROM organizations WHERE id = $1`, [context.organizationId]
    );
    if (!result.rows[0]) throw notFound('Organization');
    return result.rows[0];
  }
}

export class ProjectRepository {
  public constructor(private readonly sql: SqlExecutor) {}

  public async list(context: OrganizationContext): Promise<ProjectRecord[]> {
    const result = await this.sql.query(
      `SELECT * FROM projects WHERE organization_id = $1 AND status <> 'deleted' ORDER BY created_at DESC`,
      [context.organizationId]
    );
    return result.rows.map(mapProject);
  }

  public async get(context: OrganizationContext, projectId: string): Promise<ProjectRecord> {
    const result = await this.sql.query(
      `SELECT * FROM projects WHERE organization_id = $1 AND id = $2 AND status <> 'deleted'`,
      [context.organizationId, projectId]
    );
    if (!result.rows[0]) throw notFound('Project');
    return mapProject(result.rows[0]);
  }

  public async create(context: OrganizationContext, command: CreateProjectCommand): Promise<ProjectRecord> {
    const id = randomUUID();
    const result = await this.sql.query(
      `INSERT INTO projects
       (id, organization_id, kind, name, description, status, repository_binding,
        default_permission_policy, default_task_type, created_by)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9)
       RETURNING *`,
      [id, context.organizationId, command.kind, command.name, command.description ?? null,
        command.repository ?? null, defaultPermissionPolicy, command.defaultTaskType ?? 'general', context.userId]
    );
    return mapProject(result.rows[0]!);
  }
}

const defaultPermissionPolicy = {
  version: 1, allowNetworkAccess: false, allowRepositoryWrite: false,
  allowedConnectorScopes: [],
  approvalPolicy: {
    requirePlanApproval: false, requireExternalActionApproval: true,
    minimumToolRiskRequiringApproval: 'high',
    allowAdminOrganizationHighRiskApproval: false, allowMemberHighRiskApproval: false
  }
} as const;

const defaultResourceLimits = {
  cpuMillis: 1_000, memoryBytes: 1_073_741_824, maxPids: 256,
  diskBytes: 5_368_709_120, maxDurationMs: 1_800_000,
  maxSourceBytes: 104_857_600, maxArtifactBytes: 104_857_600,
  maxEventPayloadBytes: 65_536
} as const;

const emptyUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, durationMs: 0, toolCalls: 0 };

export class TaskRepository {
  public constructor(private readonly sql: SqlExecutor) {}

  public async list(context: OrganizationContext, projectId: string): Promise<TaskRecord[]> {
    const result = await this.sql.query(
      `SELECT * FROM tasks WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
      [context.organizationId, projectId]
    );
    return result.rows.map(mapTask);
  }

  public async get(context: OrganizationContext, taskId: string): Promise<TaskRecord> {
    const result = await this.sql.query(
      `SELECT * FROM tasks WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, taskId]
    );
    if (!result.rows[0]) throw notFound('Task');
    return mapTask(result.rows[0]);
  }

  public async create(context: OrganizationContext, command: CreateTaskCommand): Promise<TaskRecord> {
    const id = randomUUID();
    const result = await this.sql.query(
      `INSERT INTO tasks
       (id, organization_id, project_id, type, title, objective, constraints,
        acceptance_criteria, status, created_by)
       SELECT $1, $2, p.id, $4, $5, $6, $7, $8, 'open', $9
       FROM projects p WHERE p.organization_id = $2 AND p.id = $3 AND p.status <> 'deleted'
       RETURNING *`,
      [id, context.organizationId, command.projectId, command.type, command.title, command.objective,
        command.constraints ?? [], command.acceptanceCriteria ?? [], context.userId]
    );
    if (!result.rows[0]) throw notFound('Project');
    return mapTask(result.rows[0]);
  }
}

export class RunRepository {
  public constructor(
    private readonly sql: SqlExecutor,
    private readonly transactions: TransactionRunner
  ) {}

  public async get(context: OrganizationContext, runId: string): Promise<RunRecord> {
    const result = await this.sql.query(
      `SELECT * FROM runs WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, runId]
    );
    if (!result.rows[0]) throw notFound('Run');
    return mapRun(result.rows[0]);
  }

  public create(context: OrganizationContext, command: CreateRunCommand): Promise<RunRecord> {
    return this.transactions.transaction(async (client) => {
      const taskResult = await client.query(
        `SELECT t.*, COALESCE(MAX(r.attempt), 0)::integer AS last_attempt
         FROM tasks t LEFT JOIN runs r
           ON r.organization_id = t.organization_id AND r.task_id = t.id
         WHERE t.organization_id = $1 AND t.id = $2
         GROUP BY t.id FOR UPDATE OF t`, [context.organizationId, command.taskId]
      );
      const task = taskResult.rows[0];
      if (!task) throw notFound('Task');
      const id = randomUUID();
      try {
        const inserted = await client.query(
          `INSERT INTO runs
           (id, organization_id, project_id, task_id, attempt, status, mode, execution_profile,
            model_snapshot, permission_policy, resource_limits, selected_source_ids, usage,
            queued_at, created_by)
           VALUES ($1,$2,$3,$4,$5,'queued',$6,'work',$7,$8,$9,$10,$11,now(),$12)
           RETURNING *`,
          [id, context.organizationId, task.project_id, command.taskId, Number(task.last_attempt) + 1,
            command.mode, {
              requestedModelProfileId: command.requestedModelProfileId,
              provider: 'environment', model: 'environment-default', credentialHandle: 'environment-default'
            },
            defaultPermissionPolicy, defaultResourceLimits, command.selectedSourceIds ?? [], emptyUsage, context.userId]
        );
        await client.query(
          `UPDATE tasks SET latest_run_id = $3, updated_at = now()
           WHERE organization_id = $1 AND id = $2`, [context.organizationId, command.taskId, id]
        );
        await client.query(
          `INSERT INTO run_leases (run_id, organization_id, status, available_at)
           VALUES ($1, $2, 'available', now())`, [id, context.organizationId]
        );
        return mapRun(inserted.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('active_run_exists', 'Task already has an active Run');
        }
        throw error;
      }
    });
  }

  public async requestCancel(context: OrganizationContext, runId: string): Promise<RunRecord> {
    const result = await this.sql.query(
      `UPDATE runs SET status = CASE WHEN status IN ('queued','provisioning','running','waiting_for_approval')
          THEN 'cancelling' ELSE status END
       WHERE organization_id = $1 AND id = $2 RETURNING *`, [context.organizationId, runId]
    );
    if (!result.rows[0]) throw notFound('Run');
    return mapRun(result.rows[0]);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export class RunEventRepository {
  public constructor(private readonly sql: SqlExecutor) {}

  public async append(context: OrganizationContext, input: AppendRunEventInput): Promise<RunEventRecord> {
    const publicEventId = randomUUID();
    const result = await this.sql.query(
      `INSERT INTO run_events
       (public_event_id, organization_id, project_id, task_id, run_id, generation, seq, type, occurred_at, payload)
       SELECT $1, r.organization_id, r.project_id, r.task_id, r.id, $4, $5, $6, $7, $8
       FROM runs r WHERE r.organization_id = $2 AND r.id = $3
       ON CONFLICT (run_id, generation, seq) DO UPDATE SET run_id = EXCLUDED.run_id
       RETURNING public_event_id, organization_id, project_id, task_id, run_id,
                 generation, seq, type, occurred_at, payload`,
      [publicEventId, context.organizationId, input.runId, input.workerGeneration, input.seq,
        input.type, input.timestamp, input.payload]
    );
    const row = result.rows[0];
    if (!row) throw notFound('Run');
    return mapEvent(row);
  }

  public async replay(
    context: OrganizationContext,
    cursor: string | undefined,
    filters: { projectId?: string; taskId?: string; runId?: string },
    limit = 100
  ): Promise<RunEventRecord[]> {
    const result = await this.sql.query(
      `SELECT public_event_id, organization_id, project_id, task_id, run_id,
              generation, seq, type, occurred_at, payload
       FROM run_events
       WHERE organization_id = $1
         AND event_id > COALESCE((SELECT event_id FROM run_events
           WHERE organization_id = $1 AND public_event_id = $2), 0)
         AND ($3::text IS NULL OR project_id = $3)
         AND ($4::text IS NULL OR task_id = $4)
         AND ($5::text IS NULL OR run_id = $5)
       ORDER BY event_id ASC LIMIT $6`,
      [context.organizationId, cursor ?? null, filters.projectId ?? null, filters.taskId ?? null,
        filters.runId ?? null, Math.min(limit, 500)]
    );
    return result.rows.map(mapEvent);
  }
}

function mapEvent(row: Record<string, unknown>): RunEventRecord {
  return {
    eventId: String(row.public_event_id), organizationId: String(row.organization_id),
    projectId: String(row.project_id), taskId: String(row.task_id), runId: String(row.run_id),
    generation: Number(row.generation), seq: Number(row.seq), type: String(row.type),
    timestamp: iso(row.occurred_at), payload: row.payload as Record<string, unknown>
  };
}

export class ApprovalRepository {
  public constructor(private readonly sql: SqlExecutor) {}

  public async decide(
    context: OrganizationContext,
    approvalId: string,
    decision: 'approved' | 'rejected',
    idempotencyKey: string,
    reason?: string
  ): Promise<Record<string, unknown>> {
    const result = await this.sql.query(
      `UPDATE approvals SET status = $3, decided_by = $4, decision_reason = $5,
          decided_at = now(), decision_idempotency_key = $6
       WHERE organization_id = $1 AND id = $2 AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > now())
       RETURNING *`, [context.organizationId, approvalId, decision, context.userId, reason ?? null, idempotencyKey]
    );
    if (result.rows[0]) return result.rows[0];
    const existing = await this.sql.query(
      `SELECT * FROM approvals WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, approvalId]
    );
    const row = existing.rows[0];
    if (!row) throw notFound('Approval');
    if (row.decision_idempotency_key === idempotencyKey && row.status === decision) return row;
    throw conflict('approval_already_decided', 'Approval is no longer pending');
  }

  public async consume(
    context: OrganizationContext,
    approvalId: string,
    requestHash: string,
    idempotencyKey: string
  ): Promise<Record<string, unknown>> {
    const result = await this.sql.query(
      `UPDATE approvals SET consumed_at = now(), consumption_idempotency_key = $4
       WHERE organization_id = $1 AND id = $2 AND status = 'approved'
         AND request_hash = $3 AND consumed_at IS NULL
       RETURNING *`, [context.organizationId, approvalId, requestHash, idempotencyKey]
    );
    if (result.rows[0]) return result.rows[0];
    const existing = await this.sql.query(
      `SELECT * FROM approvals WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, approvalId]
    );
    const row = existing.rows[0];
    if (row?.consumption_idempotency_key === idempotencyKey && row.request_hash === requestHash) return row;
    throw conflict('approval_not_consumable', 'Approval is not approved, hash mismatched, or already consumed');
  }

  public async listPending(context: OrganizationContext): Promise<Record<string, unknown>[]> {
    const result = await this.sql.query(
      `SELECT * FROM approvals
       WHERE organization_id = $1 AND status = 'pending' ORDER BY requested_at ASC`,
      [context.organizationId]
    );
    return result.rows;
  }
}

export class TaskMessageRepository {
  public constructor(private readonly sql: SqlExecutor) {}

  public async list(context: OrganizationContext, taskId: string): Promise<Record<string, unknown>[]> {
    const result = await this.sql.query(
      `SELECT * FROM task_messages
       WHERE organization_id = $1 AND task_id = $2 ORDER BY created_at ASC, id ASC`,
      [context.organizationId, taskId]
    );
    return result.rows;
  }

  public async append(
    context: OrganizationContext,
    taskId: string,
    role: 'user' | 'agent' | 'system',
    content: readonly Record<string, unknown>[],
    runId?: string
  ): Promise<Record<string, unknown>> {
    const result = await this.sql.query(
      `INSERT INTO task_messages
       (id, organization_id, project_id, task_id, run_id, role, content, created_by)
       SELECT $1, t.organization_id, t.project_id, t.id, $4, $5, $6, $7
       FROM tasks t WHERE t.organization_id = $2 AND t.id = $3 RETURNING *`,
      [randomUUID(), context.organizationId, taskId, runId ?? null, role, content,
        role === 'user' ? context.userId : null]
    );
    if (!result.rows[0]) throw notFound('Task');
    return result.rows[0];
  }
}

export class SourceRepository {
  public constructor(private readonly sql: SqlExecutor) {}
  public async list(context: OrganizationContext, projectId: string): Promise<Record<string, unknown>[]> {
    const result = await this.sql.query(
      `SELECT * FROM sources
       WHERE organization_id = $1 AND project_id = $2 AND status <> 'deleted' ORDER BY created_at DESC`,
      [context.organizationId, projectId]
    );
    return result.rows;
  }
  public async get(context: OrganizationContext, sourceId: string): Promise<Record<string, unknown>> {
    const result = await this.sql.query(
      `SELECT * FROM sources WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, sourceId]
    );
    if (!result.rows[0]) throw notFound('Source');
    return result.rows[0];
  }
}

export class ArtifactRepository {
  public constructor(private readonly sql: SqlExecutor) {}
  public async list(context: OrganizationContext, taskId: string): Promise<Record<string, unknown>[]> {
    const result = await this.sql.query(
      `SELECT * FROM artifacts
       WHERE organization_id = $1 AND task_id = $2 AND status <> 'deleted' ORDER BY created_at DESC`,
      [context.organizationId, taskId]
    );
    return result.rows;
  }
  public async get(context: OrganizationContext, artifactId: string): Promise<Record<string, unknown>> {
    const result = await this.sql.query(
      `SELECT * FROM artifacts WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, artifactId]
    );
    if (!result.rows[0]) throw notFound('Artifact');
    return result.rows[0];
  }
}

export class AuditEventRepository {
  public constructor(private readonly sql: SqlExecutor) {}
  public async append(
    context: OrganizationContext,
    action: string,
    resourceType: string,
    resourceId: string | undefined,
    payload: Readonly<Record<string, unknown>> = {}
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO audit_events
       (organization_id, actor_user_id, action, resource_type, resource_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [context.organizationId, context.userId, action, resourceType, resourceId ?? null, payload]
    );
  }
}

export class TenantResourceRepository {
  public constructor(private readonly sql: SqlExecutor) {}

  public async getSource(context: OrganizationContext, id: string): Promise<Record<string, unknown>> {
    return this.get('sources', 'Source', context, id);
  }
  public async getArtifact(context: OrganizationContext, id: string): Promise<Record<string, unknown>> {
    return this.get('artifacts', 'Artifact', context, id);
  }
  public async appendAudit(
    context: OrganizationContext,
    action: string,
    resourceType: string,
    resourceId: string | undefined,
    payload: Readonly<Record<string, unknown>> = {}
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO audit_events
       (organization_id, actor_user_id, action, resource_type, resource_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [context.organizationId, context.userId, action, resourceType, resourceId ?? null, payload]
    );
  }
  private async get(table: 'sources' | 'artifacts', label: string, context: OrganizationContext, id: string) {
    const result = await this.sql.query(
      `SELECT * FROM ${table} WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, id]
    );
    if (!result.rows[0]) throw notFound(label);
    return result.rows[0];
  }
}

export class IdempotencyRepository {
  public constructor(private readonly sql: SqlExecutor) {}

  public async find(
    context: OrganizationContext,
    scope: string,
    key: string
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.sql.query(
      `SELECT * FROM idempotency_keys
       WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3 AND expires_at > now()`,
      [context.organizationId, scope, key]
    );
    return result.rows[0];
  }

  public async store(
    context: OrganizationContext,
    scope: string,
    key: string,
    requestHash: string,
    status: number,
    body: Readonly<Record<string, unknown>>,
    resourceId?: string
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO idempotency_keys
       (organization_id, scope, idempotency_key, request_hash, response_status, response_body, resource_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '24 hours')
       ON CONFLICT (organization_id, scope, idempotency_key) DO NOTHING`,
      [context.organizationId, scope, key, requestHash, status, body, resourceId ?? null]
    );
  }

  public async reserve(
    context: OrganizationContext,
    scope: string,
    key: string,
    requestHash: string
  ): Promise<boolean> {
    const result = await this.sql.query(
      `INSERT INTO idempotency_keys
       (organization_id, scope, idempotency_key, request_hash, expires_at)
       VALUES ($1,$2,$3,$4,now() + interval '24 hours')
       ON CONFLICT (organization_id, scope, idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [context.organizationId, scope, key, requestHash]
    );
    return result.rowCount === 1;
  }

  public async complete(
    context: OrganizationContext,
    scope: string,
    key: string,
    requestHash: string,
    status: number,
    body: Readonly<Record<string, unknown>>,
    resourceId?: string
  ): Promise<void> {
    const result = await this.sql.query(
      `UPDATE idempotency_keys SET response_status = $5, response_body = $6, resource_id = $7
       WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3 AND request_hash = $4
         AND response_body IS NULL`,
      [context.organizationId, scope, key, requestHash, status, body, resourceId ?? null]
    );
    if (result.rowCount !== 1) throw conflict('idempotency_completion_conflict', 'Idempotent request could not be completed');
  }

  public async abandon(
    context: OrganizationContext,
    scope: string,
    key: string,
    requestHash: string
  ): Promise<void> {
    await this.sql.query(
      `DELETE FROM idempotency_keys
       WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
         AND request_hash = $4 AND response_body IS NULL`,
      [context.organizationId, scope, key, requestHash]
    );
  }
}
