package com.kross.agent.dto;

import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentModel;

public final class AgentViews {
  private AgentViews() {}

  public static AgentModelView model(AgentModel row) {
    return row == null
        ? null
        : new AgentModelView(row.getId(), row.getName(), row.getProvider(), row.getModel());
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
        row.getParts(),
        row.getStatus(),
        row.getErrorSummary(),
        row.getCreatedAt());
  }
}
