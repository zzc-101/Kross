package com.kross.agent.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

public record AgentMessageView(
    String id,
    String conversationId,
    String role,
    String content,
    JsonNode parts,
    String status,
    String errorSummary,
    Instant createdAt) {}
