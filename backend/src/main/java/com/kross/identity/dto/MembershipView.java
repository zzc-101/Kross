package com.kross.identity.dto;

import java.time.Instant;

public record MembershipView(
    String id,
    String organizationId,
    String userId,
    String role,
    String status,
    Instant createdAt,
    Instant updatedAt) {}
