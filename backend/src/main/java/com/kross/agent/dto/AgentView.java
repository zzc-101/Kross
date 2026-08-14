package com.kross.agent.dto;

import java.time.Instant;

public record AgentView(
    String id,
    String organizationId,
    String userId,
    String status,
    Instant lastActiveAt,
    Instant createdAt) {}
