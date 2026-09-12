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
public class AgentSchedule {
  private String id;
  private String organizationId;
  private String agentId;
  private String userId;
  private String name;
  private String prompt;
  private String skillId;
  private String conversationMode;
  private String conversationId;
  private String timezone;
  private String kind;
  private String cronExpr;
  private Instant runAt;
  private Instant nextRunAt;
  private Instant lastRunAt;
  private String status;
  private int consecutiveFailures;
  private Instant createdAt;
  private Instant updatedAt;
}
