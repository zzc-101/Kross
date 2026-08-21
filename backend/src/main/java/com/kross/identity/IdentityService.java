package com.kross.identity;

import com.kross.api.ApiException;
import com.kross.identity.dto.IdentityViews;
import com.kross.identity.dto.MeResponse;
import com.kross.identity.dto.MembershipView;
import com.kross.identity.dto.OrganizationView;
import com.kross.identity.dto.UpdateProfileRequest;
import com.kross.identity.dto.UserProfileView;
import com.kross.identity.entity.Organization;
import com.kross.identity.entity.User;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class IdentityService {
  private final OrganizationAccess access;
  private final IdentityMapper identities;

  public MeResponse me() {
    Identity identity = access.currentIdentity();
    User row = identities.findUserById(identity.userId())
        .orElseThrow(() -> new ApiException("unauthenticated", "Sign in required", 401));
    List<MembershipView> memberships =
        identities.listMembershipsForUser(row.getId()).stream().map(IdentityViews::membership).toList();
    boolean orgAdmin = memberships.stream().anyMatch(item -> "admin".equals(item.role()));
    UserProfileView profile = IdentityViews.profile(row);
    return new MeResponse(profile, memberships, identity.superAdmin() || orgAdmin);
  }

  @Transactional
  public MeResponse updateProfile(UpdateProfileRequest request) {
    Identity identity = access.currentIdentity();
    Optional<String> displayName = Optional.ofNullable(request.displayName()).map(AuthCredentials::requireDisplayName);
    boolean setAvatar = request.avatarUrl() != null;
    Optional<String> avatar = setAvatar
        ? AuthCredentials.optionalAvatarUrl(request.avatarUrl(), true)
        : Optional.empty();
    Optional<String> gender = AuthCredentials.optionalGender(request.gender());
    boolean setPhone = request.phone() != null;
    Optional<String> phone = setPhone ? AuthCredentials.optionalPhone(request.phone()) : Optional.empty();
    identities.updateProfile(
        identity.userId(),
        displayName.orElse(null),
        setAvatar,
        avatar.orElse(null),
        gender.orElse(null),
        setPhone,
        phone.orElse(null));
    return me();
  }

  public OrganizationView getOrganization(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.ORGANIZATION_READ);
    Organization organization = identities.findOrganization(context.organizationId())
        .orElseThrow(() -> ApiException.notFound("Organization"));
    return IdentityViews.organization(organization);
  }
}
