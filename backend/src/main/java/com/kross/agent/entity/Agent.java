package com.kross.agent.entity;

import java.time.Instant;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class Agent {
  private String id;
  private String organizationId;
  private String userId;
  private String status;
  private String volumeName;
  private String containerName;
  private String containerId;
  private String lastError;
  private Instant lastActiveAt;
  private Instant createdAt;
  private Instant updatedAt;
}
