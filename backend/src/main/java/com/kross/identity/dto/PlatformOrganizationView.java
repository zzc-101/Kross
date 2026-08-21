package com.kross.identity.dto;

import java.time.Instant;

public record PlatformOrganizationView(
    String id,
    String slug,
    String name,
    String status,
    int adminCount,
    int memberCount,
    Instant createdAt) {}
