package com.kross.identity.dto;

import java.time.Instant;

public record MemberView(
    String id,
    String userId,
    String username,
    String displayName,
    String avatarUrl,
    String role,
    String status,
    Instant createdAt,
    Instant updatedAt) {}
