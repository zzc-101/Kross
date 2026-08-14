package com.kross.agent.dto;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class AgentProtocol {
  private AgentProtocol() {}

  public static String messageId() {
    return UUID.randomUUID().toString();
  }

  public record RegisterRequest(String type, String agentId) {}

  public record Registered(
      int protocolVersion,
      String type,
      String messageId,
      Instant sentAt,
      String agentId,
      int heartbeatIntervalMs,
      long idleMs) {}

  public record HeartbeatRequest(String type, String agentId) {}

  public record HeartbeatAck(
      int protocolVersion,
      String type,
      String messageId,
      Instant sentAt,
      String agentId,
      boolean shouldSleep,
      int heartbeatIntervalMs) {}

  public record HistoryTurn(String role, String content) {}

  public record Job(
      String id, String conversationId, String content, List<HistoryTurn> history, Instant createdAt) {}

  public record ReplyRequest(
      String type,
      String userMessageId,
      String content,
      String status,
      String errorSummary) {}

  public record SleepRequest(String type, String agentId) {}

  public record ModelEnvironment(Map<String, String> env) {}
}
