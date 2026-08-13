package com.kross.identity;

public record OrganizationContext(
    String organizationId, String userId, String membershipId, MembershipRole role) {}
