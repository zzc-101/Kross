package com.kross.agent.dto;

import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;

public final class AgentViews {
  private AgentViews() {}

  public static AgentView agent(Agent row) {
    return new AgentView(
        row.getId(),
        row.getOrganizationId(),
        row.getUserId(),
        row.getStatus(),
        row.getLastActiveAt(),
        row.getCreatedAt());
  }

  public static ConversationView conversation(AgentConversation row) {
    return new ConversationView(
        row.getId(),
        row.getTitle(),
        row.getArchivedAt(),
        row.getLastMessageAt(),
        row.getCreatedAt());
  }

  public static AgentMessageView message(AgentMessage row) {
    return new AgentMessageView(
        row.getId(),
        row.getConversationId(),
        row.getRole(),
        row.getContent(),
        row.getStatus(),
        row.getErrorSummary(),
        row.getCreatedAt());
  }
}
