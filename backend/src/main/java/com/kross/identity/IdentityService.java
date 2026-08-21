package com.kross.identity;

import com.kross.api.ApiException;
import com.kross.identity.dto.IdentityViews;
import com.kross.identity.dto.MeResponse;
import com.kross.identity.dto.MembershipView;
import com.kross.identity.dto.OrganizationView;
import com.kross.identity.entity.Organization;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class IdentityService {
  private final OrganizationAccess access;
  private final IdentityMapper identities;

  public MeResponse me() {
    Identity identity = access.currentIdentity();
    List<MembershipView> memberships =
        identities.listMembershipsForUser(identity.userId()).stream().map(IdentityViews::membership).toList();
    boolean orgAdmin = memberships.stream().anyMatch(item -> "admin".equals(item.role()));
    return new MeResponse(identity, memberships, identity.superAdmin() || orgAdmin);
  }

  public OrganizationView getOrganization(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.ORGANIZATION_READ);
    Organization organization = identities.findOrganization(context.organizationId())
        .orElseThrow(() -> ApiException.notFound("Organization"));
    return IdentityViews.organization(organization);
  }
}
