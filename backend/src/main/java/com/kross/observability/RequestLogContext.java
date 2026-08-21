package com.kross.observability;

import com.kross.agent.entity.Agent;
import java.util.Map;
import java.util.Optional;
import org.slf4j.MDC;

public final class RequestLogContext {
  public static final String CONVERSATION_ID = "conversationId";
  public static final String AGENT_ID = "agentId";
  public static final String NODE_ID = "nodeId";
  public static final String ORGANIZATION_ID = "organizationId";
  public static final String USER_ID = "userId";

  private RequestLogContext() {}

  public static void put(String key, String value) {
    Optional.ofNullable(value).map(String::trim).filter(text -> !text.isEmpty()).ifPresent(text -> MDC.put(key, text));
  }

  public static void bindAgent(Agent agent) {
    Optional.ofNullable(agent).ifPresent(row -> {
      put(AGENT_ID, row.getId());
      put(ORGANIZATION_ID, row.getOrganizationId());
      put(USER_ID, row.getUserId());
      put(NODE_ID, row.getNodeId());
    });
  }

  public static AutoCloseable overlay(Map<String, String> values) {
    Map<String, String> previous = MDC.getCopyOfContextMap();
    Optional.ofNullable(values).orElse(Map.of()).forEach(RequestLogContext::put);
    return () -> restore(previous);
  }

  public static Runnable propagate(Runnable action) {
    Map<String, String> captured = MDC.getCopyOfContextMap();
    return () -> {
      Map<String, String> previous = MDC.getCopyOfContextMap();
      restore(captured);
      try {
        action.run();
      } finally {
        restore(previous);
      }
    };
  }

  private static void restore(Map<String, String> context) {
    if (context == null || context.isEmpty()) {
      MDC.clear();
      return;
    }
    MDC.setContextMap(context);
  }
}
