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
public class AgentMemory {
  private String id;
  private String organizationId;
  private String userId;
  private String agentId;
  private String kind;
  private String source;
  private String content;
  private Instant forgottenAt;
  private Instant createdAt;
  private Instant updatedAt;
}
