import { describe, expect, it } from 'vitest';
import { AdminApiClient, AdminApiError } from './apiClient';

const now = '2026-08-13T08:00:00.000Z';
function response(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })); }

describe('AdminApiClient', () => {
  it('sends organization and dev identity headers', async () => {
    let headers: Headers | undefined;
    const api = new AdminApiClient({ baseUrl: 'http://kross.test', devUserId: 'dev-user', fetch: async (_url, init) => { headers = new Headers(init?.headers); return response({ counts: { activeMembers: 2, activeProjects: 1, activeRuns: 1, pendingApprovals: 0, activeConnectors: 0 } }); } });
    api.selectOrganization('org-1');
    await api.dashboard();
    expect(headers?.get('x-kross-user-id')).toBe('dev-user');
    expect(headers?.get('x-kross-organization-id')).toBe('org-1');
  });

  it('strictly rejects unknown member fields', async () => {
    const api = new AdminApiClient({ baseUrl: 'http://kross.test', fetch: () => response({ items: [{ id: 'm1', userId: 'u1', displayName: 'Lin', role: 'admin', status: 'active', createdAt: now, updatedAt: now, secret: 'must-not-leak' }], page: 1, pageSize: 20, total: 1 }) });
    await expect(api.members()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });
  });

  it('accepts an items-only page and decodes every item', async () => {
    const api = new AdminApiClient({ baseUrl: 'http://kross.test', fetch: () => response({ items: [{ id: 'm1', userId: 'u1', displayName: 'Lin', role: 'admin', status: 'active', createdAt: now, updatedAt: now }], page: 1, pageSize: 20, total: 1 }) });
    await expect(api.members()).resolves.toHaveLength(1);
  });

  it('surfaces structured server errors', async () => {
    const api = new AdminApiClient({ baseUrl: 'http://kross.test', fetch: () => response({ error: { code: 'FORBIDDEN', message: '需要管理员权限' } }, 403) });
    await expect(api.auditLogs()).rejects.toEqual(expect.objectContaining<Partial<AdminApiError>>({ status: 403, code: 'FORBIDDEN', message: '需要管理员权限' }));
  });

  it('posts first organization without an organization header', async () => {
    let headers: Headers | undefined; let body = '';
    let calls = 0;
    const api = new AdminApiClient({ baseUrl: 'http://kross.test', devUserId: 'dev-user', fetch: async (_url, init) => { headers = new Headers(init?.headers); body = String(init?.body ?? ''); calls += 1; return calls === 1 ? response({ organization: { id: 'org-1', slug: 'kross', name: 'Kross', defaultTimezone: 'Asia/Shanghai' }, membership: { id: 'm1', userId: 'dev-user', role: 'owner', status: 'active' } }) : response({ user: { userId: 'dev-user', displayName: 'Dev' }, memberships: [{ id: 'm1', organizationId: 'org-1', userId: 'dev-user', role: 'owner', status: 'active', createdAt: now, updatedAt: now }] }); } });
    const result = await api.bootstrapOrganization({ organizationId: 'org-1', name: 'Kross', slug: 'kross', defaultTimezone: 'Asia/Shanghai' });
    expect(headers?.has('x-kross-organization-id')).toBe(false);
    expect(calls).toBe(2);
    expect(result.memberships).toHaveLength(1);
  });
});
