import { describe, expect, it, vi } from 'vitest';

import type { OrganizationContext } from '@kross/work-domain';

import { ConnectorService, rejectSecrets, ScheduleService } from './connectorSchedule';
import type { QueryResult, SqlClient, SqlExecutor, TransactionRunner } from './database';

const context: OrganizationContext = {
  organizationId: 'org_a', userId: 'user_a', membershipId: 'member_a', role: 'admin'
};

describe('ConnectorService', () => {
  it('stores only credential handles and tenant-binds project installations', async () => {
    const sql = executor([[{ id: 'installation_a', organization_id: 'org_a', status: 'unavailable' }]]);
    await new ConnectorService(sql).install(context, {
      connectorDefinitionId: 'connector_a', displayName: 'Research', projectId: 'project_a',
      credentialHandle: 'vault://connector/a', grantedScopes: ['documents.read']
    });
    const [statement, values] = sql.query.mock.calls[0]!;
    expect(statement).toContain('p.organization_id = $2');
    expect(values).toContain('vault://connector/a');
    expect(JSON.stringify(values)).not.toContain('password');
  });

  it('rejects secret-shaped fields recursively and fails closed without a proxy', async () => {
    expect(() => rejectSecrets({ nested: { refresh_token: 'secret' } })).toThrow(/Plaintext secret/);
    const sql = executor([[{ exists: true }]]);
    await expect(new ConnectorService(sql).invoke(context, {
      installationId: 'installation_a', toolName: 'search', arguments: { query: 'safe' }, write: false
    })).rejects.toMatchObject({ code: 'connector_proxy_unavailable', statusCode: 503 });
  });

  it('requires Approval before any connector write', async () => {
    const sql = executor();
    await expect(new ConnectorService(sql).invoke(context, {
      installationId: 'installation_a', toolName: 'send', arguments: {}, write: true
    })).rejects.toMatchObject({ code: 'connector_write_requires_approval' });
    expect(sql.query).not.toHaveBeenCalled();
  });
});

describe('ScheduleService', () => {
  it('validates cron/timezone and persists safe fixed policies', async () => {
    const sql = executor([[{ id: 'schedule_a', status: 'active' }]]);
    const schedules = new ScheduleService(sql, transactions(sql));
    await expect(schedules.create(context, {
      projectId: 'project_a', taskId: 'task_a', cronExpression: 'bad', timezone: 'UTC', selectedSourceIds: []
    })).rejects.toMatchObject({ code: 'invalid_cron' });
    await expect(schedules.create(context, {
      projectId: 'project_a', taskId: 'task_a', cronExpression: '* * * * *', timezone: 'Mars/Olympus', selectedSourceIds: []
    })).rejects.toMatchObject({ code: 'invalid_timezone' });
    await schedules.create(context, {
      projectId: 'project_a', taskId: 'task_a', cronExpression: '*/15 * * * *', timezone: 'Asia/Shanghai', selectedSourceIds: []
    });
    expect(sql.query.mock.calls[0]![0]).toContain("'skip', 'draft_only'");
    expect(sql.query.mock.calls[0]![1]?.[1]).toBe('org_a');
  });

  it('uses SKIP LOCKED and records skip when a Task already has an active Run', async () => {
    const schedule = {
      id: 'schedule_a', organization_id: 'org_a', task_id: 'task_a', cron_expression: '* * * * *',
      timezone: 'UTC', next_run_at: new Date('2026-08-12T00:00:00Z')
    };
    const sql = executor([[schedule], [{ id: 'occurrence_a' }], [{ id: 'run_active' }], [], []]);
    expect(await new ScheduleService(sql, transactions(sql)).tick()).toBe(1);
    expect(sql.query.mock.calls[0]![0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql.query.mock.calls.some(([statement]) => statement.includes("status='skipped_active_run'"))).toBe(true);
    expect(sql.query.mock.calls.some(([statement]) => statement.includes('INSERT INTO runs'))).toBe(false);
  });

  it('creates a complete queued Run and lease exactly once for a due occurrence', async () => {
    const schedule = {
      id: 'schedule_a', organization_id: 'org_a', project_id: 'project_a', task_id: 'task_a',
      cron_expression: '0 * * * *', timezone: 'UTC', next_run_at: new Date('2026-08-12T00:00:00Z')
    };
    const sql = executor([[schedule], [{ id: 'occurrence_a' }], [], [{ id: 'run_a' }], []]);
    await new ScheduleService(sql, transactions(sql)).tick();
    const runStatement = sql.query.mock.calls.find(([statement]) => statement.includes('INSERT INTO runs'))?.[0];
    expect(runStatement).toContain('INSERT INTO run_leases');
    const runValues = sql.query.mock.calls.find(([statement]) => statement.includes('INSERT INTO runs'))?.[1];
    expect(runValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ credentialHandle: 'environment-default' }),
      expect.objectContaining({ externalActions: 'require_approval', scheduledExecution: 'draft_only' }),
      expect.objectContaining({ cpuMillis: 1000, maxEventPayloadBytes: 65536 })
    ]));
  });
});

function executor(responses: Record<string, unknown>[][] = []) {
  const query = vi.fn<(statement: string, values?: readonly unknown[]) => Promise<QueryResult>>(async () => {
    const rows = responses.shift() ?? []; return { rows, rowCount: rows.length };
  });
  return { query } as SqlExecutor & { query: typeof query };
}
function transactions(sql: SqlExecutor): TransactionRunner {
  return { transaction: async <T>(operation: (client: SqlClient) => Promise<T>) => operation(sql as SqlClient) };
}
