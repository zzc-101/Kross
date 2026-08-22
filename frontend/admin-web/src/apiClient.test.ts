import { describe, expect, it } from 'vitest';
import { AdminApiClient, AdminApiError } from './apiClient';

const now = '2026-08-13T08:00:00.000Z';
function ok(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ code: 0, message: 'ok', data }), { status, headers: { 'content-type': 'application/json' } }));
}
function failure(body: unknown, status = 403) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

const member = {
  id: 'm1', userId: 'u1', username: 'lin', displayName: 'Lin', role: 'admin' as const,
  status: 'active' as const, createdAt: now, updatedAt: now
};

describe('AdminApiClient', () => {
  it('sends organization header and session cookies', async () => {
    let headers: Headers | undefined;
    let credentials: RequestCredentials | undefined;
    const api = new AdminApiClient({ baseUrl: 'http://kross.test', fetch: async (_url, init) => {
      headers = new Headers(init?.headers);
      credentials = init?.credentials;
      return ok({
        counts: { activeMembers: 2, runningAgents: 1, stoppedAgents: 3 },
        usage: { messages1d: 4, messages7d: 11 },
        agents: [],
        nodes: []
      });
    } });
    api.selectOrganization('org-1');
    await api.dashboard();
    expect(headers?.get('x-kross-user-id')).toBeNull();
    expect(headers?.get('x-kross-organization-id')).toBe('org-1');
    expect(credentials).toBe('include');
  });

  it('strictly rejects unknown member fields', async () => {
    const api = new AdminApiClient({ baseUrl: 'http://kross.test', fetch: () => ok({ items: [{ ...member, secret: 'must-not-leak' }], page: 1, pageSize: 20, total: 1 }) });
    await expect(api.members()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });
  });

  it('accepts an items-only page and decodes every item', async () => {
    const api = new AdminApiClient({ baseUrl: 'http://kross.test', fetch: () => ok({ items: [member], page: 1, pageSize: 20, total: 1 }) });
    await expect(api.members()).resolves.toHaveLength(1);
  });

  it('surfaces structured server errors', async () => {
    const api = new AdminApiClient({ baseUrl: 'http://kross.test', fetch: () => failure({ error: { code: 'FORBIDDEN', message: '需要管理员权限' } }, 403) });
    await expect(api.auditLogs()).rejects.toEqual(expect.objectContaining<Partial<AdminApiError>>({ status: 403, code: 'FORBIDDEN', message: '需要管理员权限' }));
  });

  it('creates an organization without an organization header', async () => {
    let headers: Headers | undefined; let body = '';
    const api = new AdminApiClient({ baseUrl: 'http://kross.test', fetch: async (_url, init) => {
      headers = new Headers(init?.headers);
      body = String(init?.body ?? '');
      return ok({
        id: 'org-1', slug: 'kross', name: 'Kross', status: 'active',
        adminCount: 1, memberCount: 1, createdAt: now
      });
    } });
    const result = await api.createOrganization({
      name: 'Kross', slug: 'kross', defaultTimezone: 'Asia/Shanghai', adminUsername: 'devuser'
    });
    expect(headers?.has('x-kross-organization-id')).toBe(false);
    expect(result.slug).toBe('kross');
    expect(body).toContain('devuser');
  });
});
