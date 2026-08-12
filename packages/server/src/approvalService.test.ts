import { describe, expect, it, vi } from 'vitest';
import type { OrganizationContext } from '@kross/work-domain';
import type { QueryResult, SqlClient, TransactionRunner } from './database';
import { ApprovalService } from './approvalService';

const context: OrganizationContext = { organizationId: 'org1', userId: 'user1', membershipId: 'member1', role: 'owner' };

describe('ApprovalService', () => {
  it('decides pending approval with tenant CAS, audit and run requeue', async () => {
    const row = {
      id: 'approval1', organization_id: 'org1', project_id: 'project1', task_id: 'task1', run_id: 'run1',
      status: 'pending', scope: 'run', risk_level: 'critical', request_hash: 'a'.repeat(64),
      permission_policy: { approvalPolicy: {} }, decision_idempotency_key: null
    };
    const client = fakeClient([[row], [{ ...row, status: 'approved' }], [{ id: 'run1' }], [{ run_id: 'run1' }], [], []]);
    const result = await new ApprovalService(client, transaction(client)).decide(context, {
      approvalId: 'approval1', decision: 'approved', idempotencyKey: 'decision1'
    });
    expect(result.status).toBe('approved');
    const statements = (client.query.mock.calls as unknown as Array<[string, readonly unknown[] | undefined]>).map(([sql]) => sql);
    expect(statements.some((sql) => sql.includes("status = 'pending'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("status = 'queued'"))).toBe(true);
    expect(statements.some((sql) => sql.includes('audit_events'))).toBe(true);
  });

  it('atomically consumes a decision for one worker generation', async () => {
    const row = {
      id: 'approval1', status: 'approved', decision_idempotency_key: 'decision1', decision_reason: null,
      decided_at: '2026-08-12T00:00:00.000Z', request_hash: 'a'.repeat(64)
    };
    const client = fakeClient([[row], [{ id: 'approval1' }]]);
    const decision = await new ApprovalService(client, transaction(client)).nextWorkerDecision({ organizationId: 'org1', runId: 'run1', generation: 2 });
    expect(decision).toMatchObject({ approvalId: 'approval1', generation: 2, decision: 'approved' });
    const calls = client.query.mock.calls as unknown as Array<[string, readonly unknown[] | undefined]>;
    expect(calls[1]?.[1]).toEqual(['org1', 'approval1', 2, 'worker-generation-2']);
  });
});

function fakeClient(responses: Record<string, unknown>[][]) {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]): Promise<QueryResult> => {
    const rows = responses.shift() ?? [];
    return { rows, rowCount: rows.length };
  });
  return { query, release() {} } as unknown as SqlClient & { query: typeof query };
}
function transaction(client: SqlClient): TransactionRunner {
  return { transaction: async <T>(operation: (value: SqlClient) => Promise<T>) => operation(client) };
}
