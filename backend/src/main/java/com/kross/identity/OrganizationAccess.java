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
    return Optional.ofNullable(SecurityContextHolder.getContext().getAuthentication())
        .map(Authentication::getPrincipal)
        .filter(Identity.class::isInstance)
        .map(Identity.class::cast)
        .orElseThrow(() -> new ApiException("unauthenticated", "Missing development user identity", 401));
  }

  public OrganizationContext require(String organizationId, OrganizationAction action) {
    Identity identity = currentIdentity();
    String parsed = Ids.requireResourceId(organizationId, "Invalid Organization identifier");
    var membership = identities
        .findActiveMembership(parsed, identity.userId())
        .orElseThrow(() -> new ApiException("organization_access_denied", "Organization access denied", 403));
    MembershipRole role = MembershipRole.fromWire(membership.getRole());
    Rbac.assertCanPerform(role, action);
    return new OrganizationContext(parsed, identity.userId(), membership.getId(), role);
  }
}
