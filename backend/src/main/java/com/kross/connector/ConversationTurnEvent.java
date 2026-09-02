package com.kross.connector;

import java.util.List;

public record ConversationTurnEvent(
    String conversationId,
    String organizationId,
    String userId,
    Kind kind,
    String content,
    String errorSummary,
    List<Approval> approvals) {

  public enum Kind {
    COMPLETED,
    FAILED,
    APPROVAL_REQUIRED
  }

  public record Approval(String approvalId, String toolName, String reason, String inputPreview) {}
}
