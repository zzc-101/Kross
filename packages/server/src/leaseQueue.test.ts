import { describe, expect, it, vi } from 'vitest';

import type { QueryResult, SqlClient, TransactionRunner } from './database';
import { PostgresLeaseQueue } from './leaseQueue';

describe('PostgresLeaseQueue', () => {
  it('claims exactly one unlocked job and increments generation', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ run_id: 'run_a', organization_id: 'org_a' }], rowCount: 1 } satisfies QueryResult)
      .mockResolvedValueOnce({ rows: [{
        lease_id: 'lease_a', organization_id: 'org_a', run_id: 'run_a', lease_owner: 'orch_a',
        generation: 3, lease_expires_at: new Date('2026-08-12T00:00:00Z')
      }], rowCount: 1 } satisfies QueryResult);
    const runner: TransactionRunner = { transaction: async (operation) => operation({ query, release: vi.fn() } as SqlClient) };
    const lease = await new PostgresLeaseQueue(runner).claim('orch_a', 30_000);
    const calls = query.mock.calls as unknown as [string, readonly unknown[] | undefined][];
    expect(calls[0]![0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(calls[1]![0]).toContain('generation = generation + 1');
    expect(lease?.generation).toBe(3);
  });

  it('renews with owner, generation, tenant and non-expired CAS predicates', async () => {
    const query = vi.fn(async () => ({ rows: [{
      lease_id: 'lease_a', organization_id: 'org_a', run_id: 'run_a', lease_owner: 'orch_a',
      generation: 2, lease_expires_at: new Date()
    }], rowCount: 1 }));
    const runner: TransactionRunner = { transaction: async (operation) => operation({ query, release: vi.fn() } as SqlClient) };
    await new PostgresLeaseQueue(runner).renew(
      { organizationId: 'org_a', userId: 'user_a', membershipId: 'member_a', role: 'admin' },
      'lease_a', 'orch_a', 2, 30_000
    );
    const calls = query.mock.calls as unknown as [string, readonly unknown[] | undefined][];
    expect(calls[0]![0]).toContain('organization_id = $1');
    expect(calls[0]![0]).toContain('generation = $4');
    expect(calls[0]![0]).toContain('lease_expires_at > now()');
  });
});
