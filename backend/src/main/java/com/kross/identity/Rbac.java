package com.kross.identity;

import com.kross.api.ApiException;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;

public final class Rbac {
  private static final Set<OrganizationAction> MEMBER = EnumSet.of(
      OrganizationAction.ORGANIZATION_READ,
      OrganizationAction.MEMBERSHIP_READ,
      OrganizationAction.AGENT_READ,
      OrganizationAction.AGENT_CHAT);

  private static final Set<OrganizationAction> ADMIN = with(
      MEMBER,
      OrganizationAction.ORGANIZATION_UPDATE,
      OrganizationAction.MEMBERSHIP_INVITE,
      OrganizationAction.MEMBERSHIP_UPDATE,
      OrganizationAction.MEMBERSHIP_REMOVE,
      OrganizationAction.CREDENTIAL_MANAGE,
      OrganizationAction.MODEL_PROFILE_MANAGE,
      OrganizationAction.AGENT_MANAGE,
      OrganizationAction.SKILL_MANAGE,
      OrganizationAction.TOKEN_USAGE_READ,
      OrganizationAction.AUDIT_READ);

  private Rbac() {}

  public static boolean canPerform(MembershipRole role, OrganizationAction action) {
    return switch (role) {
      case ADMIN -> ADMIN.contains(action);
      case MEMBER -> MEMBER.contains(action);
    };
  }

  public static void assertCanPerform(MembershipRole role, OrganizationAction action) {
    if (!canPerform(role, action)) {
      throw new ApiException("permission_denied", "Organization access denied", 403);
    }
  }

  public static boolean canManageRole(MembershipRole actor, MembershipRole target) {
    return actor == MembershipRole.ADMIN
        && (target == MembershipRole.ADMIN || target == MembershipRole.MEMBER);
  }

  private static Set<OrganizationAction> with(Set<OrganizationAction> base, OrganizationAction... extra) {
    EnumSet<OrganizationAction> copy = EnumSet.copyOf(base);
    copy.addAll(List.of(extra));
    return Set.copyOf(copy);
  }
}
