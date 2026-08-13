package com.kross.support;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;

public final class Policies {
  private static final ObjectMapper MAPPER = new ObjectMapper();

  private Policies() {}

  public static ObjectNode defaultApprovalPolicy() {
    ObjectNode policy = MAPPER.createObjectNode();
    policy.put("requirePlanApproval", false);
    policy.put("requireExternalActionApproval", true);
    policy.put("minimumToolRiskRequiringApproval", "high");
    policy.put("allowAdminOrganizationHighRiskApproval", false);
    policy.put("allowMemberHighRiskApproval", false);
    return policy;
  }

  public static ObjectNode defaultPermissionPolicy(boolean allowNetwork) {
    ObjectNode policy = MAPPER.createObjectNode();
    policy.put("version", 1);
    policy.put("allowNetworkAccess", allowNetwork);
    policy.put("allowRepositoryWrite", false);
    policy.set("allowedConnectorScopes", MAPPER.createArrayNode());
    policy.set("approvalPolicy", defaultApprovalPolicy());
    return policy;
  }

  public static ObjectNode defaultResourceLimits() {
    ObjectNode limits = MAPPER.createObjectNode();
    limits.put("cpuMillis", 1_000);
    limits.put("memoryBytes", 1_073_741_824L);
    limits.put("maxPids", 256);
    limits.put("diskBytes", 5_368_709_120L);
    limits.put("maxDurationMs", 1_800_000);
    limits.put("maxSourceBytes", 104_857_600);
    limits.put("maxArtifactBytes", 104_857_600);
    limits.put("maxEventPayloadBytes", 65_536);
    return limits;
  }

  public static ObjectNode emptyUsage() {
    ObjectNode usage = MAPPER.createObjectNode();
    usage.put("inputTokens", 0);
    usage.put("outputTokens", 0);
    usage.put("estimatedCostUsd", 0);
    usage.put("durationMs", 0);
    usage.put("toolCalls", 0);
    return usage;
  }

  public static ObjectNode modelSnapshot(String provider, String model, String credentialHandle) {
    ObjectNode snapshot = MAPPER.createObjectNode();
    snapshot.put("provider", provider);
    snapshot.put("model", model);
    snapshot.put("credentialHandle", credentialHandle);
    return snapshot;
  }

  public static JsonNode stringArray(List<String> values) {
    return MAPPER.valueToTree(values);
  }
}
