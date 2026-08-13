package com.kross.identity.dto;

import com.kross.identity.entity.DashboardCounts;
import com.kross.identity.entity.Member;
import com.kross.identity.entity.Membership;
import com.kross.identity.entity.Organization;

public final class IdentityViews {
  private IdentityViews() {}

  public static MembershipView membership(Membership row) {
    return new MembershipView(
        row.getId(),
        row.getOrganizationId(),
        row.getUserId(),
        row.getRole(),
        row.getStatus(),
        row.getCreatedAt(),
        row.getUpdatedAt());
  }

  public static MemberView member(Member row) {
    return new MemberView(
        row.getId(),
        row.getUserId(),
        row.getDisplayName(),
        row.getRole(),
        row.getStatus(),
        row.getCreatedAt(),
        row.getUpdatedAt());
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
        row.getActiveProjects(),
        row.getActiveRuns(),
        row.getPendingApprovals(),
        row.getActiveConnectors());
  }
}
