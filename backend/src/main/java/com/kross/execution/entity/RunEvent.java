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
public class RunEvent {
  private String eventId;
  private String organizationId;
  private String projectId;
  private String taskId;
  private String runId;
  private int generation;
  private long seq;
  private String type;
  private Instant timestamp;
  private JsonNode payload;
}
