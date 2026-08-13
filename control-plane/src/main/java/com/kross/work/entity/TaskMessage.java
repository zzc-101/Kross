package com.kross.work.entity;

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
public class TaskMessage {
  private String id;
  private String organizationId;
  private String projectId;
  private String taskId;
  private String runId;
  private String role;
  private JsonNode content;
  private String createdBy;
  private Instant createdAt;
}
