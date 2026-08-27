package com.kross.orchestrator;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

public final class AgentNames {
  private AgentNames() {}

  public static String container(String agentId) {
    return "kross-agent-" + digest(agentId);
  }

  public static String volume(String agentId) {
    return "kross-agent-vol-" + digest(agentId);
  }

  public static String workspaceClaim(String agentId) {
    return "kross-work-" + digest(agentId);
  }

  private static String digest(String agentId) {
    try {
      return HexFormat.of().formatHex(
          MessageDigest.getInstance("SHA-256").digest(agentId.getBytes(StandardCharsets.UTF_8)))
          .substring(0, 16);
    } catch (Exception error) {
      throw new IllegalStateException(error);
    }
  }
}
