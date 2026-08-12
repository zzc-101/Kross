import { randomUUID } from 'node:crypto';

import { assertCanDecideApproval, type OrganizationContext } from '@kross/work-domain';
import { approvalDecisionMessageSchema, type ApprovalDecisionMessage } from '@kross/protocol';

import type { SqlExecutor, TransactionRunner } from './database';
import { conflict, notFound, ServerError } from './errors';

export class ApprovalService {
  public constructor(private readonly sql: SqlExecutor, private readonly transactions: TransactionRunner) {}

  public async listPending(context: OrganizationContext): Promise<Record<string, unknown>[]> {
    const result = await this.sql.query(
      `SELECT * FROM approvals WHERE organization_id = $1 AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > now()) ORDER BY requested_at ASC`,
      [context.organizationId]
    );
    return result.rows;
  }

  public async decide(context: OrganizationContext, input: {
    approvalId: string;
    decision: 'approved' | 'rejected';
    idempotencyKey: string;
    reason?: string;
  }): Promise<Record<string, unknown>> {
    return this.transactions.transaction(async (client) => {
      const selected = await client.query(
        `SELECT a.*, r.permission_policy, r.status AS run_status
         FROM approvals a JOIN runs r ON r.organization_id = a.organization_id AND r.id = a.run_id
         WHERE a.organization_id = $1 AND a.id = $2 FOR UPDATE`,
        [context.organizationId, input.approvalId]
      );
      const row = selected.rows[0];
      if (!row) throw notFound('Approval');
      if (row.decision_idempotency_key === input.idempotencyKey && row.status === input.decision) return row;
      if (row.status !== 'pending') throw conflict('approval_already_decided', 'Approval is no longer pending');
      if (row.expires_at != null && Date.parse(String(row.expires_at)) <= Date.now()) {
        await client.query(`UPDATE approvals SET status = 'expired' WHERE organization_id = $1 AND id = $2 AND status = 'pending'`, [context.organizationId, input.approvalId]);
        throw conflict('approval_expired', 'Approval has expired');
      }
      const policy = asRecord(asRecord(row.permission_policy).approvalPolicy ?? asRecord(row.permission_policy).approval_policy);
      try {
        assertCanDecideApproval({
          membership: { status: 'active', role: context.role },
          approval: { status: 'pending', scope: String(row.scope) as 'run' | 'organization', riskLevel: String(row.risk_level) as 'low' | 'medium' | 'high' | 'critical' },
          policy: {
            allowAdminOrganizationHighRiskApproval: Boolean(policy.allowAdminOrganizationHighRiskApproval),
            allowMemberHighRiskApproval: Boolean(policy.allowMemberHighRiskApproval)
          },
          hasRunAccess: true
        });
      } catch (error) {
        throw new ServerError('approval_forbidden', error instanceof Error ? error.message : 'Approval decision is forbidden', 403);
      }
      const updated = await client.query(
        `UPDATE approvals SET status = $3, decided_by = $4, decision_reason = $5,
           decided_at = now(), decision_idempotency_key = $6
         WHERE organization_id = $1 AND id = $2 AND status = 'pending'
         RETURNING *`,
        [context.organizationId, input.approvalId, input.decision, context.userId, input.reason ?? null, input.idempotencyKey]
      );
      if (!updated.rows[0]) throw conflict('approval_decision_raced', 'Approval decision raced');
      await client.query(
        `UPDATE runs SET status = 'queued', updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'waiting_for_approval'`,
        [context.organizationId, row.run_id]
      );
      await client.query(
        `UPDATE run_leases SET status = 'available', available_at = now(), lease_id = NULL,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE organization_id = $1 AND run_id = $2 AND status IN ('released','available')`,
        [context.organizationId, row.run_id]
      );
      await client.query(
        `INSERT INTO audit_events (organization_id, actor_user_id, action, resource_type, resource_id, payload)
         VALUES ($1,$2,'approval.decide','approval',$3,$4)`,
        [context.organizationId, context.userId, input.approvalId, { decision: input.decision, runId: row.run_id, requestHash: row.request_hash }]
      );
      await client.query(
        `INSERT INTO run_events
         (public_event_id, organization_id, project_id, task_id, run_id, generation, seq, type, occurred_at, payload)
         SELECT $1, $2, $3, $4, $5, COALESCE(MAX(generation), 1), COALESCE(MAX(seq), 0) + 1,
           'approval.decided', now(), $6 FROM run_events WHERE run_id = $5`,
        [randomUUID(), context.organizationId, row.project_id, row.task_id, row.run_id,
          { approvalId: input.approvalId, status: input.decision, decidedBy: context.userId }]
      );
      return updated.rows[0];
    });
  }

  /** Returns the sole resolved decision for a resumed run and fences it to the new generation. */
  public async nextWorkerDecision(input: { organizationId: string; runId: string; generation: number }): Promise<ApprovalDecisionMessage | undefined> {
    return this.transactions.transaction(async (client) => {
      const consumptionKey = `worker-generation-${input.generation}`;
      const result = await client.query(
        `SELECT * FROM approvals WHERE organization_id = $1 AND run_id = $2
         AND status IN ('approved','rejected')
         AND (decision_delivered_generation IS NULL OR decision_delivered_generation = $3)
         ORDER BY decided_at ASC LIMIT 1 FOR UPDATE`,
        [input.organizationId, input.runId, input.generation]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const consumed = await client.query(
        `UPDATE approvals SET decision_delivered_at = COALESCE(decision_delivered_at, now()),
           decision_delivered_generation = COALESCE(decision_delivered_generation, $3),
           consumed_at = CASE WHEN status = 'approved' THEN COALESCE(consumed_at, now()) ELSE consumed_at END,
           consumption_idempotency_key = CASE WHEN status = 'approved' THEN COALESCE(consumption_idempotency_key, $4) ELSE consumption_idempotency_key END
         WHERE organization_id = $1 AND id = $2
           AND (decision_delivered_generation IS NULL OR decision_delivered_generation = $3) RETURNING id`,
        [input.organizationId, row.id, input.generation, consumptionKey]
      );
      if (!consumed.rows[0]) throw conflict('approval_consumption_raced', 'Approval consumption raced');
      return approvalDecisionMessageSchema.parse({
        protocolVersion: 2, messageId: randomUUID(), sentAt: new Date().toISOString(), type: 'approval.decision',
        decisionId: row.decision_idempotency_key, runId: input.runId, generation: input.generation,
        approvalId: row.id, decision: row.status, ...(row.decision_reason == null ? {} : { reason: row.decision_reason }),
        decidedAt: new Date(String(row.decided_at)).toISOString(), requestHash: row.request_hash
      });
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
