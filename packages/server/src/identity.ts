import {
  assertMembershipCanPerform,
  type OrganizationAction,
  type OrganizationContext
} from '@kross/work-domain';
import { resourceIdSchema } from '@kross/protocol';

import { ServerError } from './errors';
import type { MembershipRepository } from './repositories';

export interface Identity {
  readonly userId: string;
  readonly displayName: string;
}

export interface IdentityRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface IdentityProvider {
  authenticate(request: IdentityRequest): Promise<Identity>;
}

/** Explicit development-only identity. Production wiring must replace this provider. */
export class DevIdentityProvider implements IdentityProvider {
  public constructor(private readonly enabled: boolean) {}

  public async authenticate(request: IdentityRequest): Promise<Identity> {
    if (!this.enabled) {
      throw new ServerError('dev_identity_disabled', 'Development identity is disabled', 401);
    }
    const userId = resourceIdSchema.safeParse(request.headers['x-kross-user-id']);
    if (!userId.success) throw new ServerError('unauthenticated', 'Missing development user identity', 401);
    return {
      userId: userId.data,
      displayName: request.headers['x-kross-user-name']?.trim() || userId.data
    };
  }
}

export class OrganizationContextResolver {
  public constructor(private readonly memberships: MembershipRepository) {}

  public async resolve(
    identity: Identity,
    organizationId: string,
    action: OrganizationAction
  ): Promise<OrganizationContext> {
    const parsedOrganizationId = resourceIdSchema.safeParse(organizationId);
    if (!parsedOrganizationId.success) {
      throw new ServerError('invalid_organization', 'Invalid Organization identifier', 400);
    }
    const membership = await this.memberships.findActive(parsedOrganizationId.data, identity.userId);
    if (!membership) throw new ServerError('organization_access_denied', 'Organization access denied', 403);
    assertMembershipCanPerform(membership, action);
    return {
      organizationId: membership.organizationId,
      userId: identity.userId,
      membershipId: membership.id,
      role: membership.role
    };
  }
}
