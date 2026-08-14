package com.kross.agent.dto;

import java.time.Instant;

public record AgentMessageView(
    String id,
    String conversationId,
    String role,
    String content,
    String status,
    String errorSummary,
    Instant createdAt) {}
