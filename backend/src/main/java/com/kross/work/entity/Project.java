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
public class Project {
  private String id;
  private String organizationId;
  private String kind;
  private String name;
  private String description;
  private String status;
  private JsonNode repositoryBinding;
  private JsonNode defaultPermissionPolicy;
  private String defaultTaskType;
  private String createdBy;
  private Instant createdAt;
  private Instant updatedAt;
}
