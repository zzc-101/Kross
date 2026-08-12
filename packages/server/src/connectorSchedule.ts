import { randomUUID } from 'node:crypto';

import type { OrganizationContext } from '@kross/work-domain';

import type { SqlExecutor, TransactionRunner } from './database';
import { conflict, notFound, ServerError } from './errors';

const ACTIVE_RUN_STATUSES = ['queued', 'provisioning', 'running', 'waiting_for_approval', 'cancelling'];
const SECRET_KEYS = /^(secret|token|password|api[_-]?key|client[_-]?secret|refresh[_-]?token)$/i;

export interface ConnectorProxyRequest {
  readonly installationId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly write: boolean;
}

export interface ConnectorProxy {
  invoke(context: OrganizationContext, request: ConnectorProxyRequest): Promise<unknown>;
}

/** Safe default: connector metadata can be configured, but calls fail closed until a proxy is wired. */
export class UnavailableConnectorProxy implements ConnectorProxy {
  public async invoke(): Promise<never> {
    throw new ServerError('connector_proxy_unavailable', 'Connector execution is not configured', 503);
  }
}

export class ConnectorService {
  public constructor(private readonly sql: SqlExecutor, private readonly proxy: ConnectorProxy = new UnavailableConnectorProxy()) {}

  public async list(context: OrganizationContext) {
    const result = await this.sql.query(
      `SELECT i.id, i.organization_id, i.project_id, i.connector_definition_id, i.display_name,
              i.granted_scopes, i.status, i.last_error_code, i.created_at, i.updated_at,
              d.name AS connector_name, d.allowed_tools, d.required_scopes
       FROM connector_installations i JOIN connector_definitions d ON d.id = i.connector_definition_id
       WHERE i.organization_id = $1 AND i.status <> 'revoked' ORDER BY i.created_at DESC`,
      [context.organizationId]
    );
    return result.rows;
  }

  public async install(context: OrganizationContext, input: {
    connectorDefinitionId: string; displayName: string; projectId?: string;
    credentialHandle?: string; grantedScopes: readonly string[];
  }) {
    rejectSecrets(input);
    const result = await this.sql.query(
      `INSERT INTO connector_installations
       (id, organization_id, project_id, connector_definition_id, display_name, credential_handle,
        granted_scopes, status, last_error_code, installed_by)
       SELECT $1, $2, $3, d.id, $5, $6, $7,
              CASE WHEN d.status = 'available' THEN 'available' ELSE 'unavailable' END,
              CASE WHEN d.status = 'available' THEN NULL ELSE 'proxy_unavailable' END, $8
       FROM connector_definitions d
       WHERE d.id = $4 AND ($3::text IS NULL OR EXISTS (
         SELECT 1 FROM projects p WHERE p.organization_id = $2 AND p.id = $3))
         AND d.required_scopes <@ $7::jsonb
       RETURNING id, organization_id, project_id, connector_definition_id, display_name,
                 granted_scopes, status, last_error_code, created_at, updated_at`,
      [randomUUID(), context.organizationId, input.projectId ?? null, input.connectorDefinitionId,
        input.displayName, input.credentialHandle ?? null, input.grantedScopes, context.userId]
    );
    if (!result.rows[0]) throw notFound('Connector definition, Project, or required scope');
    return result.rows[0];
  }

  public async revoke(context: OrganizationContext, installationId: string) {
    const result = await this.sql.query(
      `UPDATE connector_installations SET status = 'revoked', credential_handle = NULL, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND status <> 'revoked'
       RETURNING id, organization_id, project_id, connector_definition_id, display_name,
                 granted_scopes, status, last_error_code, created_at, updated_at`,
      [context.organizationId, installationId]
    );
    if (!result.rows[0]) throw notFound('Connector installation');
    return result.rows[0];
  }

  public async invoke(context: OrganizationContext, request: ConnectorProxyRequest): Promise<unknown> {
    rejectSecrets(request.arguments);
    if (request.write) throw new ServerError('connector_write_requires_approval', 'Connector write requires Approval', 409);
    const allowed = await this.sql.query(
      `SELECT 1 FROM connector_installations i JOIN connector_definitions d ON d.id = i.connector_definition_id
       WHERE i.organization_id = $1 AND i.id = $2 AND i.status = 'available'
         AND d.status = 'available' AND d.allowed_tools ? $3`,
      [context.organizationId, request.installationId, request.toolName]
    );
    if (!allowed.rows[0]) throw new ServerError('connector_unavailable', 'Connector or tool is unavailable', 503);
    return this.proxy.invoke(context, request);
  }
}

export interface ScheduleCreateInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly selectedSourceIds: readonly string[];
}

export class ScheduleService {
  public constructor(private readonly sql: SqlExecutor, private readonly transactions: TransactionRunner) {}

  public async list(context: OrganizationContext) {
    return (await this.sql.query(
      `SELECT * FROM schedules WHERE organization_id = $1 AND status <> 'deleted' ORDER BY created_at DESC`,
      [context.organizationId]
    )).rows;
  }

  public async create(context: OrganizationContext, input: ScheduleCreateInput) {
    assertCron(input.cronExpression); assertTimezone(input.timezone);
    const nextRunAt = nextCron(input.cronExpression, input.timezone, new Date());
    const result = await this.sql.query(
      `INSERT INTO schedules
       (id, organization_id, project_id, task_id, cron_expression, timezone, selected_source_ids,
        next_run_at, concurrency_policy, external_action_policy, created_by)
       SELECT $1, t.organization_id, t.project_id, t.id, $5, $6, $7, $8, 'skip', 'draft_only', $9
       FROM tasks t WHERE t.organization_id = $2 AND t.project_id = $3 AND t.id = $4 RETURNING *`,
      [randomUUID(), context.organizationId, input.projectId, input.taskId, input.cronExpression,
        input.timezone, input.selectedSourceIds, nextRunAt.toISOString(), context.userId]
    );
    if (!result.rows[0]) throw notFound('Task');
    return result.rows[0];
  }

  public async setStatus(context: OrganizationContext, scheduleId: string, status: 'active' | 'paused') {
    const result = await this.sql.query(
      `UPDATE schedules SET status = $3, updated_at = now(),
          next_run_at = CASE WHEN $3 = 'active' THEN GREATEST(next_run_at, now()) ELSE next_run_at END
       WHERE organization_id = $1 AND id = $2 AND status <> 'deleted' RETURNING *`,
      [context.organizationId, scheduleId, status]
    );
    if (!result.rows[0]) throw notFound('Schedule');
    return result.rows[0];
  }

  /** Claims due rows with SKIP LOCKED; duplicate ticks collapse through the occurrence unique keys. */
  public async tick(limit = 20): Promise<number> {
    return this.transactions.transaction(async (client) => {
      const due = await client.query(
        `SELECT * FROM schedules WHERE status = 'active' AND next_run_at <= now()
         ORDER BY next_run_at, id FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]
      );
      for (const schedule of due.rows) await this.trigger(client, schedule);
      return due.rows.length;
    });
  }

  private async trigger(sql: SqlExecutor, schedule: Record<string, unknown>): Promise<void> {
    const scheduledFor = iso(schedule.next_run_at);
    const idempotencyKey = `schedule:${String(schedule.id)}:${scheduledFor}`;
    const occurrenceId = randomUUID();
    const reserved = await sql.query(
      `INSERT INTO schedule_occurrences
       (id, organization_id, schedule_id, scheduled_for, status, idempotency_key, detail)
       VALUES ($1,$2,$3,$4,'failed',$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [occurrenceId, schedule.organization_id, schedule.id, scheduledFor, idempotencyKey, { reserved: true }]
    );
    if (!reserved.rows[0]) {
      await this.advance(sql, schedule);
      return;
    }
    const active = await sql.query(
      `SELECT id FROM runs WHERE organization_id = $1 AND task_id = $2 AND status = ANY($3::text[]) LIMIT 1`,
      [schedule.organization_id, schedule.task_id, ACTIVE_RUN_STATUSES]
    );
    if (active.rows[0]) {
      await sql.query(
        `UPDATE schedule_occurrences SET status='skipped_active_run', detail=$3
         WHERE organization_id=$1 AND id=$2`,
        [schedule.organization_id, occurrenceId, { activeRunId: active.rows[0].id }]
      );
    } else {
      const runId = randomUUID();
      await sql.query(
        `WITH created AS (
           INSERT INTO runs
           (id, organization_id, project_id, task_id, attempt, status, mode, execution_profile,
            model_snapshot, permission_policy, resource_limits, selected_source_ids, usage, queued_at, created_by)
           SELECT $1, s.organization_id, s.project_id, s.task_id,
             COALESCE((SELECT MAX(attempt)+1 FROM runs r WHERE r.organization_id=s.organization_id AND r.task_id=s.task_id),1),
             'queued','auto','work',$5, $6, $7, s.selected_source_ids, $8, now(), s.created_by
           FROM schedules s WHERE s.organization_id=$2 AND s.id=$3
           RETURNING id
         ), lease AS (
           INSERT INTO run_leases (run_id, organization_id, status, available_at)
           SELECT id, $2, 'available', now() FROM created
         ), latest AS (
           UPDATE tasks SET latest_run_id=$1, updated_at=now() WHERE organization_id=$2 AND id=$4
         ) UPDATE schedule_occurrences SET status='triggered', run_id=$1, detail='{}'
           WHERE organization_id=$2 AND id=$9`,
        [runId, schedule.organization_id, schedule.id, schedule.task_id,
          { provider: 'environment', model: 'environment-default', credentialHandle: 'environment-default' },
          {
            version: 1, allowNetworkAccess: false, allowRepositoryWrite: false,
            allowedConnectorScopes: [], externalActions: 'require_approval', scheduledExecution: 'draft_only',
            approvalPolicy: {
              requirePlanApproval: false, requireExternalActionApproval: true,
              minimumToolRiskRequiringApproval: 'high', allowAdminOrganizationHighRiskApproval: false,
              allowMemberHighRiskApproval: false
            }
          },
          {
            cpuMillis: 1_000, memoryBytes: 1_073_741_824, maxPids: 256, diskBytes: 5_368_709_120,
            maxDurationMs: 1_800_000, maxSourceBytes: 104_857_600, maxArtifactBytes: 104_857_600,
            maxEventPayloadBytes: 65_536
          },
          { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, durationMs: 0, toolCalls: 0 },
          occurrenceId]
      );
    }
    await this.advance(sql, schedule);
  }

  private async advance(sql: SqlExecutor, schedule: Record<string, unknown>): Promise<void> {
    const next = nextCron(String(schedule.cron_expression), String(schedule.timezone), new Date(iso(schedule.next_run_at)));
    await sql.query(
      `UPDATE schedules SET next_run_at = $3,
          updated_at = now() WHERE organization_id = $1 AND id = $2`,
      [schedule.organization_id, schedule.id, next.toISOString()]
    );
  }
}

export function rejectSecrets(value: unknown, path = '$'): void {
  if (Array.isArray(value)) { value.forEach((item, index) => rejectSecrets(item, `${path}[${index}]`)); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) throw new ServerError('plaintext_secret_forbidden', `Plaintext secret field is forbidden at ${path}.${key}`, 400);
    rejectSecrets(child, `${path}.${key}`);
  }
}
function assertCron(value: string): void {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^(\*|\d+|\*\/\d+|\d+-\d+)(,(\*|\d+|\*\/\d+|\d+-\d+))*$/.test(field))) {
    throw new ServerError('invalid_cron', 'Schedule requires a valid five-field cron expression', 400);
  }
}
function assertTimezone(value: string): void {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); }
  catch { throw new ServerError('invalid_timezone', 'Unknown IANA timezone', 400); }
}
function nextCron(expression: string, timezone: string, after: Date): Date {
  const fields = expression.trim().split(/\s+/);
  const candidate = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric',
    weekday: 'short', hourCycle: 'h23'
  });
  for (let offset = 0; offset < 527_040; offset += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
    if (matchesCronField(fields[0]!, Number(parts.minute), 0, 59) &&
        matchesCronField(fields[1]!, Number(parts.hour), 0, 23) &&
        matchesCronField(fields[2]!, Number(parts.day), 1, 31) &&
        matchesCronField(fields[3]!, Number(parts.month), 1, 12) &&
        matchesCronField(fields[4]!, weekday, 0, 6)) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new ServerError('cron_no_occurrence', 'Cron has no occurrence within one year', 400);
}
function matchesCronField(field: string, value: number, minimum: number, maximum: number): boolean {
  return field.split(',').some((part) => {
    if (part === '*') return true;
    if (part.startsWith('*/')) {
      const step = Number(part.slice(2)); return step > 0 && (value - minimum) % step === 0;
    }
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number); return start! >= minimum && end! <= maximum && value >= start! && value <= end!;
    }
    return Number(part) === value && value >= minimum && value <= maximum;
  });
}
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
