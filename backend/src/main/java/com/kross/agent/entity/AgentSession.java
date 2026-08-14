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
public class AgentSession {
  private String tokenHash;
  private String organizationId;
  private String agentId;
  private Instant expiresAt;
}
