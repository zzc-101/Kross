package com.kross.orchestrator;

public final class KubernetesAgentNames {
  public static final String AGENT_LABEL = "dev.kross.agent/id";
  public static final String MANAGER_LABEL = "dev.kross.agent/manager";
  public static final String AGENT_ID_ANNOTATION = "kross-agent-id";
  public static final String WORKSPACE_PATH_ANNOTATION = "kross-workspace-path";

  private KubernetesAgentNames() {}

  public static String pod(String agentId) {
    return AgentNames.container(agentId);
  }

  public static String pvc(String agentId) {
    return AgentNames.workspaceClaim(agentId);
  }

  public static String workspacePath(String agentId) {
    return "agents/" + agentId;
  }
}
