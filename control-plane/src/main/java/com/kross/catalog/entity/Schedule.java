package com.kross.catalog.entity;

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
public class Schedule {
  private String id;
  private String organizationId;
  private String projectId;
  private String taskId;
  private String cronExpression;
  private String timezone;
  private JsonNode selectedSourceIds;
  private String status;
  private Instant nextRunAt;
  private String concurrencyPolicy;
  private String externalActionPolicy;
  private String createdBy;
  private Instant createdAt;
  private Instant updatedAt;
}
