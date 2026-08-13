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
public class Run {
  private String id;
  private String organizationId;
  private String projectId;
  private String taskId;
  private int attempt;
  private String status;
  private String mode;
  private JsonNode modelSnapshot;
  private JsonNode permissionPolicy;
  private JsonNode resourceLimits;
  private JsonNode selectedSourceIds;
  private JsonNode usage;
  private Instant queuedAt;
  private Instant startedAt;
  private Instant finishedAt;
  private String createdBy;
}
