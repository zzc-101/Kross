package com.kross.identity.dto;

import com.kross.identity.entity.DashboardCounts;
import com.kross.identity.entity.Member;
import com.kross.identity.entity.Membership;
import com.kross.identity.entity.Organization;
import com.kross.identity.entity.OrganizationListRow;
import com.kross.identity.entity.User;
import java.util.Optional;

public final class IdentityViews {
  private IdentityViews() {}

  public static MembershipView membership(Membership row) {
    return new MembershipView(
        row.getId(),
        row.getOrganizationId(),
        row.getOrganizationName(),
        row.getOrganizationSlug(),
        row.getUserId(),
        row.getRole(),
        row.getStatus(),
        row.getCreatedAt(),
        row.getUpdatedAt());
  }

  public static PlatformOrganizationView platformOrganization(OrganizationListRow row) {
    return new PlatformOrganizationView(
        row.getId(),
        row.getSlug(),
        row.getName(),
        row.getStatus(),
        Optional.ofNullable(row.getAdminCount()).orElse(0),
        Optional.ofNullable(row.getMemberCount()).orElse(0),
        row.getCreatedAt());
  }

  public static MemberView member(Member row) {
    return new MemberView(
        row.getId(),
        row.getUserId(),
        row.getUsername(),
        row.getDisplayName(),
        row.getRole(),
        row.getStatus(),
        row.getCreatedAt(),
        row.getUpdatedAt());
  }

  public static UserAccountView account(User row) {
    return new UserAccountView(
        row.getId(),
        row.getUsername(),
        row.getDisplayName(),
        row.getPlatformRole(),
        row.getStatus(),
        row.getCreatedAt());
  }

  public static OrganizationView organization(Organization organization) {
    return new OrganizationView(
        organization.getId(),
        organization.getSlug(),
        organization.getName(),
        organization.getStatus(),
        organization.getDefaultTimezone(),
        organization.getDataRetentionDays(),
        organization.getApprovalPolicy(),
        organization.getCreatedAt(),
        organization.getUpdatedAt());
  }

  public static OrganizationPolicyView policy(Organization organization) {
    return new OrganizationPolicyView(
        organization.getDefaultTimezone(),
        organization.getDataRetentionDays(),
        organization.getApprovalPolicy());
  }

  public static DashboardCountsView counts(DashboardCounts row) {
    return new DashboardCountsView(
        row.getActiveMembers(),
        row.getRunningAgents(),
        row.getStoppedAgents());
  }
}
