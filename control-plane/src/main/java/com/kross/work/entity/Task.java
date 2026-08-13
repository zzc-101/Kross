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
public class Task {
  private String id;
  private String organizationId;
  private String projectId;
  private String type;
  private String title;
  private String objective;
  private JsonNode constraints;
  private JsonNode acceptanceCriteria;
  private String status;
  private String latestRunId;
  private String createdBy;
  private Instant createdAt;
  private Instant updatedAt;
}
