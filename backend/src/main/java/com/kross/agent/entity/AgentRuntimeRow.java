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
public class AgentRuntimeRow {
  private String id;
  private String userId;
  private String username;
  private String displayName;
  private String status;
  private String nodeId;
  private String lastError;
  private Instant lastActiveAt;
}
