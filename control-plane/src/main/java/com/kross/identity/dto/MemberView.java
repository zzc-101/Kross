package com.kross.identity.dto;

import java.time.Instant;

public record MemberView(
    String id,
    String userId,
    String displayName,
    String role,
    String status,
    Instant createdAt,
    Instant updatedAt) {}
