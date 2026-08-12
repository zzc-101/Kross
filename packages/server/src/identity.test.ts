import { describe, expect, it, vi } from 'vitest';

import { DevIdentityProvider, OrganizationContextResolver } from './identity';

describe('identity and organization RBAC', () => {
  it('keeps development identity explicitly gated', async () => {
    await expect(new DevIdentityProvider(false).authenticate({ headers: { 'x-kross-user-id': 'user_a' } })).rejects.toMatchObject({ statusCode: 401 });
    await expect(new DevIdentityProvider(true).authenticate({ headers: { 'x-kross-user-id': 'user_a' } })).resolves.toMatchObject({ userId: 'user_a' });
  });

  it('uses work-domain permissions after resolving active membership', async () => {
    const memberships = { findActive: vi.fn(async () => ({
      id: 'membership_a', organizationId: 'org_a', userId: 'user_a', role: 'viewer', status: 'active',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    })) };
    const resolver = new OrganizationContextResolver(memberships as never);
    await expect(resolver.resolve({ userId: 'user_a', displayName: 'A' }, 'org_a', 'project.read')).resolves.toMatchObject({ role: 'viewer' });
    await expect(resolver.resolve({ userId: 'user_a', displayName: 'A' }, 'org_a', 'project.create')).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
