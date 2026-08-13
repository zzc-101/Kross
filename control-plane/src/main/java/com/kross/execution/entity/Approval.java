package com.kross.execution.entity;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class Approval {
  private String id;
  private String organizationId;
  private String projectId;
  private String taskId;
  private String runId;
  private String kind;
  private String scope;
  private String status;
  private String riskLevel;
  private String actionPreview;
  private JsonNode target;
  private String requestHash;
  private Instant requestedAt;
  private Instant expiresAt;
  private String decidedBy;
  private String decisionReason;
  private Instant decidedAt;
  private String decisionIdempotencyKey;
  private JsonNode permissionPolicy;
  private String runStatus;
}
