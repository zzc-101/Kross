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
public class AgentScheduleRun {
  private String id;
  private String scheduleId;
  private String organizationId;
  private String conversationId;
  private String userMessageId;
  private Instant dueAt;
  private Instant claimedAt;
  private String status;
  private String error;
}
