package com.kross.identity.dto;

import java.time.Instant;

public record InviteView(
    String id,
    String role,
    Instant expiresAt,
    Instant acceptedAt,
    Instant createdAt) {}
