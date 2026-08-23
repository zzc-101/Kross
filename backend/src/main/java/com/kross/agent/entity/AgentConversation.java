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
public class AgentConversation {
  private String id;
  private String organizationId;
  private String agentId;
  private String title;
  private String mode;
  private String modelId;
  private String skillId;
  private Instant archivedAt;
  private Instant lastMessageAt;
  private Instant createdAt;
  private Instant updatedAt;
}
