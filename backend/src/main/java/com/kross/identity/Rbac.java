package com.kross.identity;

import java.util.EnumSet;
import java.util.Set;
import org.springframework.security.access.AccessDeniedException;

public final class Rbac {
  private static final Set<OrganizationAction> VIEWER = EnumSet.of(
      OrganizationAction.ORGANIZATION_READ,
      OrganizationAction.MEMBERSHIP_READ,
      OrganizationAction.PROJECT_READ,
      OrganizationAction.SOURCE_READ,
      OrganizationAction.TASK_READ,
      OrganizationAction.RUN_READ,
      OrganizationAction.APPROVAL_READ,
      OrganizationAction.ARTIFACT_READ,
      OrganizationAction.SCHEDULE_READ);

  private static final Set<OrganizationAction> MEMBER = with(
      VIEWER,
      OrganizationAction.PROJECT_CREATE,
      OrganizationAction.SOURCE_CREATE,
      OrganizationAction.TASK_CREATE,
      OrganizationAction.RUN_CREATE,
      OrganizationAction.APPROVAL_DECIDE);

  private static final Set<OrganizationAction> ADMIN = with(
      MEMBER,
      OrganizationAction.MEMBERSHIP_INVITE,
      OrganizationAction.MEMBERSHIP_UPDATE,
      OrganizationAction.MEMBERSHIP_REMOVE,
      OrganizationAction.CREDENTIAL_MANAGE,
      OrganizationAction.MODEL_PROFILE_MANAGE,
      OrganizationAction.CONNECTOR_MANAGE,
      OrganizationAction.PROJECT_UPDATE,
      OrganizationAction.PROJECT_DELETE,
      OrganizationAction.SOURCE_DELETE,
      OrganizationAction.TASK_UPDATE,
      OrganizationAction.TASK_CANCEL,
      OrganizationAction.TASK_ARCHIVE,
      OrganizationAction.RUN_CANCEL,
      OrganizationAction.ARTIFACT_DELETE,
      OrganizationAction.SCHEDULE_MANAGE,
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

  public static boolean canDecideHighRisk(
      MembershipRole role, String scope, boolean allowAdminOrg, boolean allowMember) {
    if (role == MembershipRole.OWNER) {
      return true;
    }
    if (role == MembershipRole.ADMIN) {
      return "run".equals(scope) || allowAdminOrg;
    }
    if (role == MembershipRole.MEMBER) {
      return "run".equals(scope) && allowMember;
    }
    return false;
  }

  @SafeVarargs
  private static Set<OrganizationAction> with(Set<OrganizationAction> base, OrganizationAction... extra) {
    EnumSet<OrganizationAction> copy = EnumSet.copyOf(base);
    copy.addAll(Set.of(extra));
    return copy;
  }
}
