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
public class AgentMessage {
  private String id;
  private String organizationId;
  private String agentId;
  private String conversationId;
  private String role;
  private String content;
  private String status;
  private String errorSummary;
  private String createdBy;
  private Instant createdAt;
}
