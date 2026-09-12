package com.kross.agent;

import java.util.Optional;
import java.util.UUID;

final class WorkspaceObjectKeys {
  private WorkspaceObjectKeys() {}

  static String objectKey(String organizationId, String agentId, String relativePath) {
    return prefix(organizationId, agentId) + relativePath;
  }

  static String stagingKey(String organizationId, String agentId) {
    return prefix(organizationId, agentId) + ".staging/" + UUID.randomUUID();
  }

  static boolean isStagingKey(String organizationId, String agentId, String key) {
    String prefix = prefix(organizationId, agentId) + ".staging/";
    String value = Optional.ofNullable(key).orElse("");
    if (!value.startsWith(prefix)) {
      return false;
    }
    String rest = value.substring(prefix.length());
    return !rest.isBlank() && !rest.contains("/") && !rest.contains("..");
  }

  private static String prefix(String organizationId, String agentId) {
    return "workspaces/" + organizationId + "/" + agentId + "/";
  }
}
