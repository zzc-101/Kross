import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { SqlExecutor, TransactionRunner } from './database';
import { PostgresWorkerControlService } from './workerControl';

describe('PostgresWorkerControlService', () => {
  it('persists only a SHA-256 digest when issuing a run token', async () => {
    const query = vi.fn(async (_text: string, values?: readonly unknown[]) => ({
      rows: [{ expires_at: values?.[5] }], rowCount: 1
    }));
    const service = new PostgresWorkerControlService(
      { query } as SqlExecutor,
      {} as TransactionRunner,
      { now: () => new Date('2026-08-12T00:00:00.000Z') }
    );

    const issued = await service.issueRunToken({
      leaseId: 'lease_1', organizationId: 'org_1', runId: 'run_1', owner: 'orch_1',
      generation: 1, expiresAt: '2026-08-12T00:01:00.000Z'
    });

    const values = query.mock.calls[0]![1]!;
    expect(values).not.toContain(issued.token);
    expect(values[0]).toBe(createHash('sha256').update(issued.token).digest('hex'));
    expect(String(values[0])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a message whose run binding differs before mutating registration', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        token_hash: createHash('sha256').update('secret').digest('hex'),
        organization_id: 'org_1', run_id: 'run_1', generation: 2, lease_id: 'lease_1',
        expires_at: '2026-08-12T00:01:00.000Z', lease_owner: 'orch_1'
      }], rowCount: 1
    }));
    const service = new PostgresWorkerControlService({ query } as SqlExecutor, {} as TransactionRunner);

    await expect(service.register('secret', {
      type: 'worker.register', protocolVersion: 2, messageId: 'message_1',
      sentAt: '2026-08-12T00:00:00.000Z', workerId: 'worker_1', runId: 'other_run',
      generation: 2, leaseId: 'lease_1', workerVersion: '1.0.0',
      capabilities: { checkpointResume: true, artifactUpload: true, connectorProxy: false }
    })).rejects.toMatchObject({ code: 'worker_token_mismatch', statusCode: 401 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('projects a terminal event before completing the lease on release', async () => {
    const tokenHash = createHash('sha256').update('secret').digest('hex');
    const queries: string[] = [];
    const query = vi.fn(async (text: string) => {
      queries.push(text);
      if (text.includes('FROM worker_run_tokens t')) return { rows: [{
        token_hash: tokenHash, organization_id: 'org_1', run_id: 'run_1', generation: 2,
        lease_id: 'lease_1', expires_at: '2026-08-12T00:01:00.000Z', lease_owner: 'orch_1',
        worker_session_id: 'session_1', worker_id: 'worker_1'
      }], rowCount: 1 };
      if (text.includes('accepted_through_seq')) return { rows: [{ accepted_through_seq: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query } as SqlExecutor;
    const transactions: TransactionRunner = { transaction: async (operation) => operation(client as never) };
    const service = new PostgresWorkerControlService(client, transactions);
    await service.appendEvent('secret', {
      protocolVersion: 2, runId: 'run_1', generation: 2, seq: 1,
      timestamp: '2026-08-12T00:00:00.000Z',
      event: { type: 'run.terminal', terminal: { status: 'completed', summary: 'done', finishedAt: '2026-08-12T00:00:00.000Z' } }
    });
    await service.release('secret', {
      type: 'lease.release', protocolVersion: 2, messageId: 'message_1', sentAt: '2026-08-12T00:00:01.000Z',
      workerSessionId: 'session_1', runId: 'run_1', generation: 2, leaseId: 'lease_1', reason: 'terminal'
    });

    expect(queries.some((text) => text.includes("WHEN $7 = 'run.terminal'"))).toBe(true);
    expect(queries.some((text) => text.includes("THEN 'completed'"))).toBe(true);
  });
});
