package com.kross.identity.dto;

import java.time.Instant;

public record AuthLoginEventView(
    String id,
    String eventType,
    String method,
    String outcome,
    String username,
    String userId,
    String reason,
    String ip,
    String userAgent,
    Instant occurredAt) {}
