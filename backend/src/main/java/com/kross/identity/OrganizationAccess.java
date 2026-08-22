package com.kross.identity;

import com.kross.api.ApiException;
import com.kross.support.Ids;
import java.util.Optional;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import lombok.RequiredArgsConstructor;

@Service
@RequiredArgsConstructor
public class OrganizationAccess {
  private final IdentityMapper identities;

  public Identity currentIdentity() {
    return findCurrentIdentity()
        .orElseThrow(() -> new ApiException("unauthenticated", "Sign in required", 401));
  }

  public Optional<Identity> findCurrentIdentity() {
    return Optional.ofNullable(SecurityContextHolder.getContext().getAuthentication())
        .map(Authentication::getPrincipal)
        .filter(Identity.class::isInstance)
        .map(Identity.class::cast);
  }

  public OrganizationContext require(String organizationId, OrganizationAction action) {
    Identity identity = currentIdentity();
    String parsed = Ids.requireResourceId(organizationId, "Invalid Organization identifier");
    identities.findOrganization(parsed)
        .filter(organization -> "active".equals(organization.getStatus()))
        .orElseThrow(() -> new ApiException("organization_unavailable", "Organization is not active", 403));
    var membership = identities
        .findActiveMembership(parsed, identity.userId())
        .orElseThrow(() -> new ApiException("organization_access_denied", "Organization access denied", 403));
    MembershipRole role = MembershipRole.fromWire(membership.getRole());
    Rbac.assertCanPerform(role, action);
    return new OrganizationContext(parsed, identity.userId(), membership.getId(), role);
  }
}
