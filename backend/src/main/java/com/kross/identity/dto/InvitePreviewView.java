package com.kross.identity.dto;

import java.time.Instant;

public record InvitePreviewView(
    String organizationName,
    String organizationSlug,
    String role,
    Instant expiresAt,
    boolean accepted) {}
