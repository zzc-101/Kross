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
public class RunSpecData {
  private String projectId;
  private String taskId;
  private String taskType;
  private String taskTitle;
  private String taskObjective;
  private JsonNode taskConstraints;
  private JsonNode taskAcceptanceCriteria;
  private JsonNode messages;
  private JsonNode repositoryBinding;
  private JsonNode permissionPolicy;
  private JsonNode modelSnapshot;
  private JsonNode resourceLimits;
  private JsonNode selectedSourceIds;
  private String mode;
  private String executionProfile;
  private String checkpointKey;
  private Instant leaseExpiresAt;
}
