package com.kross.agent.dto;

import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentModel;
import java.util.Optional;

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
        Optional.ofNullable(row.getMode()).filter(value -> !value.isBlank()).orElse("auto"),
        row.getModelId(),
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
