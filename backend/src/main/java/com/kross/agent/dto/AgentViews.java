package com.kross.agent.dto;

import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;

public final class AgentViews {
  private AgentViews() {}

  public static ConversationView conversation(AgentConversation row) {
    return new ConversationView(
        row.getId(),
        row.getTitle(),
        row.getSkillId(),
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
        row.getContextUsage() != null && row.getContextUsage().isObject() && row.getContextUsage().isEmpty()
            ? null
            : row.getContextUsage(),
        row.getStatus(),
        row.getErrorSummary(),
        row.getCreatedAt());
  }
}
