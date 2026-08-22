package com.kross.identity.dto;

import java.time.Instant;

public record CreatedInviteView(
    String id,
    String token,
    String role,
    Instant expiresAt,
    String path) {}
