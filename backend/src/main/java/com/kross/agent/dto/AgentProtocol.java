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
      String type,
      String id,
      String conversationId,
      String agentMessageId,
      String content,
      List<HistoryTurn> history,
      Instant createdAt,
      String mode,
      String modelId) {
    public Job(
        String id,
        String conversationId,
        String agentMessageId,
        String content,
        List<HistoryTurn> history,
        Instant createdAt,
        String mode,
        String modelId) {
      this("agent.job", id, conversationId, agentMessageId, content, history, createdAt, mode, modelId);
    }
  }

  public record ModelEnvironmentRequest(String type, String modelId) {}

  public record Command(
      String type,
      String commandId,
      String name,
      Map<String, Object> payload) {
    public Command(String commandId, String name, Map<String, Object> payload) {
      this("agent.command", commandId, name, payload == null ? Map.of() : payload);
    }
  }

  public record CommandResult(
      String type,
      String commandId,
      boolean ok,
      Map<String, Object> payload,
      String error) {}

  public record WorkerSettings(String type, Map<String, Object> mcpServers) {
    public WorkerSettings(Map<String, Object> mcpServers) {
      this("agent.settings", mcpServers == null ? Map.of() : mcpServers);
    }
  }

  public record ReplyRequest(
      String type,
      String userMessageId,
      String agentMessageId,
      String content,
      String status,
      String errorSummary,
      com.fasterxml.jackson.databind.JsonNode parts) {}

  public record StreamEventsRequest(
      String type,
      String userMessageId,
      String agentMessageId,
      List<StreamEvent> events) {}

  public record StreamEvent(
      String type,
      String text,
      String id,
      String name,
      Object input,
      String content,
      Boolean ok) {}

  public record SleepRequest(String type, String agentId) {}

  public record ApprovalDecision(
      String type,
      String approvalId,
      boolean approved,
      String reason) {
    public ApprovalDecision(String approvalId, boolean approved, String reason) {
      this("agent.approval", approvalId, approved, reason);
    }
  }

  public record ModelEnvironment(String type, Map<String, String> env) {
    public ModelEnvironment(Map<String, String> env) {
      this("agent.model_environment", env);
    }
  }

  public record SocketError(String type, String code, String message) {
    public static SocketError of(String code, String message) {
      return new SocketError("agent.error", code, message);
    }
  }
}
