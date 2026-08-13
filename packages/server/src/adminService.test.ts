import { describe, expect, it, vi } from 'vitest';

import { AdminService } from './adminService';
import type { SqlExecutor, TransactionRunner } from './database';
import { ServerError } from './errors';
import type { OrganizationContextResolver } from './identity';

const identity = { userId: 'owner-user', displayName: 'Owner' };
const context = { organizationId: 'org-a', userId: identity.userId, membershipId: 'membership-a', role: 'owner' as const };

function service(query?: SqlExecutor['query'], bootstrapEnabled = true) {
  const queryMock = query ?? vi.fn(async <Row extends Record<string, unknown>>() => ({ rows: [] as Row[], rowCount: 0 }));
  const sql = { query: queryMock } as SqlExecutor;
  const transaction = vi.fn(async <T>(operation: (client: SqlExecutor) => Promise<T>) => operation(sql));
  const transactions = { transaction } as TransactionRunner;
  const contexts = { resolve: vi.fn(async () => context) } as unknown as OrganizationContextResolver;
  return { admin: new AdminService({ sql, transactions, contexts, bootstrapEnabled }), query: queryMock, contexts, transaction };
}

describe('AdminService security boundaries', () => {
  it('fails closed when development bootstrap is disabled', async () => {
    const { admin } = service(undefined, false);
    await expect(admin.bootstrap(identity, { organizationId: 'org-a', slug: 'org-a', name: 'Org A' }))
      .rejects.toMatchObject({ code: 'bootstrap_disabled', statusCode: 403 });
  });

  it('bootstraps the only organization and owner in one transaction', async () => {
    const responses: Record<string, unknown>[][] = [[], [], [], [], [], [], []];
    const query = vi.fn(async <Row extends Record<string, unknown>>(_text: string, _values?: readonly unknown[]) => ({ rows: (responses.shift() ?? []) as Row[], rowCount: 0 }));
    const { admin, transaction } = service(query as SqlExecutor['query']);
    const result = await admin.bootstrap(identity, { slug: 'first-org', name: 'First Org', defaultTimezone: 'Asia/Shanghai' });
    expect(transaction).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ organization: { slug: 'first-org', name: 'First Org' }, membership: { userId: 'owner-user', role: 'owner', status: 'active' } });
    expect(result.organization.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(query.mock.calls.map((call) => String(call[0])).join('\n')).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls.at(-1)?.[1]).toContain('organization.bootstrap');
  });

  it('rejects secret material instead of persisting plaintext credentials', async () => {
    const { admin, query } = service();
    expect(() => admin.createCredential(identity, 'org-a', {
      name: 'OpenAI', provider: 'openai', handle: 'vault://openai', metadata: { api_key: 'plaintext' }
    })).toThrow(ServerError);
    expect(query).not.toHaveBeenCalled();
  });

  it('tenant-scopes and paginates audit log queries', async () => {
    const query = vi.fn(async <Row extends Record<string, unknown>>() => ({ rows: [{ id: 9, action: 'model.create', resource_type: 'model_profile', payload: {}, occurred_at: '2026-01-01', total: 1 }] as unknown as Row[], rowCount: 1 }));
    const setup = service(query as SqlExecutor['query']); const { admin, contexts } = setup;
    const result = await admin.listAuditLogs(identity, 'org-a', { page: '2', pageSize: '10' });
    expect(contexts.resolve).toHaveBeenCalledWith(identity, 'org-a', 'audit.read');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE organization_id=$1'), ['org-a', null, null, 10, 10]);
    expect(result).toMatchObject({ page: 2, pageSize: 10, total: 1 });
  });
});
