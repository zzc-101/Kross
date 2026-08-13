package com.kross.execution.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;

public record ApprovalView(
    String id,
    @JsonProperty("organization_id") String organizationId,
    @JsonProperty("project_id") String projectId,
    @JsonProperty("task_id") String taskId,
    @JsonProperty("run_id") String runId,
    String kind,
    String scope,
    @JsonProperty("risk_level") String riskLevel,
    @JsonProperty("action_preview") String actionPreview,
    String status,
    @JsonProperty("requested_at") Instant requestedAt,
    @JsonProperty("expires_at") Instant expiresAt,
    @JsonProperty("decided_at") Instant decidedAt,
    @JsonProperty("decided_by") String decidedBy,
    @JsonProperty("decision_idempotency_key") String decisionIdempotencyKey) {}
