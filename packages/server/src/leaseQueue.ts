import { randomUUID } from 'node:crypto';

import type { OrganizationContext } from '@kross/work-domain';

import type { SqlClient, TransactionRunner } from './database';
import { conflict, notFound } from './errors';

export interface RunLease {
  readonly leaseId: string;
  readonly organizationId: string;
  readonly runId: string;
  readonly owner: string;
  readonly generation: number;
  readonly expiresAt: string;
}

export class PostgresLeaseQueue {
  public constructor(private readonly transactions: TransactionRunner) {}

  public claim(owner: string, leaseDurationMs: number): Promise<RunLease | undefined> {
    return this.transactions.transaction(async (client) => {
      const candidate = await client.query(
        `SELECT run_id, organization_id FROM run_leases
         WHERE status IN ('available','released') AND available_at <= now()
         ORDER BY available_at, run_id
         FOR UPDATE SKIP LOCKED LIMIT 1`
      );
      const row = candidate.rows[0];
      if (!row) return undefined;
      const leaseId = randomUUID();
      const leased = await client.query(
        `UPDATE run_leases SET status = 'leased', lease_id = $3, lease_owner = $4,
            lease_expires_at = now() + ($5 * interval '1 millisecond'),
            generation = generation + 1, attempts = attempts + 1, updated_at = now()
         WHERE organization_id = $1 AND run_id = $2
         RETURNING lease_id, organization_id, run_id, lease_owner, generation, lease_expires_at`,
        [row.organization_id, row.run_id, leaseId, owner, leaseDurationMs]
      );
      return mapLease(leased.rows[0]!);
    });
  }

  public renew(
    context: OrganizationContext,
    leaseId: string,
    owner: string,
    generation: number,
    leaseDurationMs: number
  ): Promise<RunLease> {
    return this.transactions.transaction(async (client) => {
      const result = await client.query(
        `UPDATE run_leases SET lease_expires_at = now() + ($5 * interval '1 millisecond'), updated_at = now()
         WHERE organization_id = $1 AND lease_id = $2 AND lease_owner = $3
           AND generation = $4 AND status = 'leased' AND lease_expires_at > now()
         RETURNING lease_id, organization_id, run_id, lease_owner, generation, lease_expires_at`,
        [context.organizationId, leaseId, owner, generation, leaseDurationMs]
      );
      if (!result.rows[0]) throw conflict('lease_lost', 'Lease is expired, released, or owned by another orchestrator');
      return mapLease(result.rows[0]);
    });
  }

  public release(
    context: OrganizationContext,
    leaseId: string,
    owner: string,
    generation: number,
    delayMs = 0
  ): Promise<void> {
    return this.transactions.transaction(async (client) => {
      const result = await client.query(
        `UPDATE run_leases SET status = 'released', available_at = now() + ($5 * interval '1 millisecond'),
            lease_id = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE organization_id = $1 AND lease_id = $2 AND lease_owner = $3
           AND generation = $4 AND status = 'leased'`,
        [context.organizationId, leaseId, owner, generation, delayMs]
      );
      if (result.rowCount !== 1) throw notFound('Lease');
    });
  }
}

function mapLease(row: Record<string, unknown>): RunLease {
  const expiresAt = row.lease_expires_at;
  return {
    leaseId: String(row.lease_id), organizationId: String(row.organization_id),
    runId: String(row.run_id), owner: String(row.lease_owner), generation: Number(row.generation),
    expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt)
  };
}

/** Keeps the interface honest in fake transaction tests. */
export type LeaseSqlClient = SqlClient;
