import { describe, expect, it, vi } from 'vitest';

import type { OrganizationContext } from '@kross/work-domain';

import type { QueryResult, SqlExecutor, TransactionRunner } from './database';
import { ApprovalRepository, ProjectRepository, RunEventRepository, TenantResourceRepository } from './repositories';

const context: OrganizationContext = {
  organizationId: 'org_a', userId: 'user_a', membershipId: 'member_a', role: 'admin'
};

function executor(responses: Record<string, unknown>[][] = [[]]) {
  const query = vi.fn(async (): Promise<QueryResult> => {
    const rows = responses.shift() ?? [];
    return { rows, rowCount: rows.length };
  });
  return { query } as SqlExecutor & { query: typeof query };
}

describe('tenant repositories', () => {
  it('always binds organizationId when reading resources by ID', async () => {
    const sql = executor([[{ id: 'source_a' }], [{ id: 'artifact_a' }], [{
      id: 'project_a', organization_id: 'org_a', kind: 'general', name: 'P', status: 'active',
      created_by: 'user_a', created_at: new Date(), updated_at: new Date()
    }]]);
    const resources = new TenantResourceRepository(sql);
    await resources.getSource(context, 'source_a');
    await resources.getArtifact(context, 'artifact_a');
    await new ProjectRepository(sql).get(context, 'project_a');
    for (const [statement, values] of sql.query.mock.calls as unknown as [string, readonly unknown[] | undefined][]) {
      expect(statement).toContain('organization_id = $1');
      expect(values?.[0]).toBe('org_a');
    }
  });

  it('appends worker events with database idempotency on generation and sequence', async () => {
    const row = {
      public_event_id: 'event_a', organization_id: 'org_a', project_id: 'project_a',
      task_id: 'task_a', run_id: 'run_a', generation: 2, seq: 4,
      type: 'run.progress', occurred_at: new Date(), payload: { type: 'run.progress', data: {} }
    };
    const sql = executor([[row]]);
    await new RunEventRepository(sql).append(context, {
      runId: 'run_a', workerGeneration: 2, seq: 4, type: 'run.progress',
      timestamp: new Date().toISOString(), payload: { type: 'run.progress', data: {} }
    });
    const appendCall = (sql.query.mock.calls as unknown as [string, readonly unknown[] | undefined][])[0]!;
    expect(appendCall[0]).toContain('ON CONFLICT (run_id, generation, seq)');
    expect(appendCall[1]?.[1]).toBe('org_a');
  });

  it('uses compare-and-set for approval decision and consumption', async () => {
    const sql = executor([[{ id: 'approval_a', status: 'approved' }], [{ id: 'approval_a' }]]);
    const approvals = new ApprovalRepository(sql);
    await approvals.decide(context, 'approval_a', 'approved', 'decision_a');
    await approvals.consume(context, 'approval_a', 'a'.repeat(64), 'consume_a');
    const calls = sql.query.mock.calls as unknown as [string, readonly unknown[] | undefined][];
    expect(calls[0]![0]).toContain("status = 'pending'");
    expect(calls[1]![0]).toContain('consumed_at IS NULL');
  });
});
