package com.kross.identity.dto;

import java.time.Instant;

public record AgentRuntimeView(
    String id,
    String userId,
    String username,
    String displayName,
    String status,
    String nodeId,
    String lastError,
    Instant lastActiveAt,
    boolean connected) {}
