package com.kross.work.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

public record TaskMessageView(
    String id,
    String organizationId,
    String projectId,
    String taskId,
    String runId,
    String role,
    JsonNode content,
    String createdBy,
    Instant createdAt) {}
