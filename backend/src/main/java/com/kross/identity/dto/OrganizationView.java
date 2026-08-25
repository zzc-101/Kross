package com.kross.identity.dto;

import java.time.Instant;

public record OrganizationView(
    String id,
    String slug,
    String name,
    String status,
    String defaultTimezone,
    Integer dataRetentionDays,
    Instant createdAt,
    Instant updatedAt) {}
