package com.kross.identity.dto;

import java.time.Instant;

public record UserAccountView(
    String userId,
    String username,
    String displayName,
    String platformRole,
    String status,
    Instant createdAt) {}
