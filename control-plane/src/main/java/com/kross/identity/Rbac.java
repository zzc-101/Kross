package com.kross.identity;

import java.util.EnumSet;
import java.util.Set;
import org.springframework.security.access.AccessDeniedException;

public final class Rbac {
  private static final Set<OrganizationAction> VIEWER = EnumSet.of(
      OrganizationAction.ORGANIZATION_READ,
      OrganizationAction.MEMBERSHIP_READ,
      OrganizationAction.AGENT_READ);

  private static final Set<OrganizationAction> MEMBER = with(
      VIEWER,
      OrganizationAction.AGENT_CHAT);

  private static final Set<OrganizationAction> ADMIN = with(
      MEMBER,
      OrganizationAction.MEMBERSHIP_INVITE,
      OrganizationAction.MEMBERSHIP_UPDATE,
      OrganizationAction.MEMBERSHIP_REMOVE,
      OrganizationAction.CREDENTIAL_MANAGE,
      OrganizationAction.MODEL_PROFILE_MANAGE,
      OrganizationAction.AGENT_MANAGE,
      OrganizationAction.AUDIT_READ);

  private Rbac() {}

  public static boolean canPerform(MembershipRole role, OrganizationAction action) {
    return switch (role) {
      case OWNER -> true;
      case ADMIN -> ADMIN.contains(action);
      case MEMBER -> MEMBER.contains(action);
      case VIEWER -> VIEWER.contains(action);
    };
  }

  public static void assertCanPerform(MembershipRole role, OrganizationAction action) {
    if (!canPerform(role, action)) {
      throw new AccessDeniedException("Organization access denied");
    }
  }

  public static boolean canManageRole(MembershipRole actor, MembershipRole target) {
    if (actor == MembershipRole.OWNER) {
      return true;
    }
    return actor == MembershipRole.ADMIN
        && (target == MembershipRole.MEMBER || target == MembershipRole.VIEWER);
  }

  private static Set<OrganizationAction> with(Set<OrganizationAction> base, OrganizationAction... extra) {
    EnumSet<OrganizationAction> copy = EnumSet.copyOf(base);
    copy.addAll(java.util.List.of(extra));
    return Set.copyOf(copy);
  }
}
