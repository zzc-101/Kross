package com.kross.channel;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.AgentService;
import com.kross.agent.dto.AgentProtocol;
import com.kross.api.ApiException;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Slf4j
@Component
@RequiredArgsConstructor
public class AgentWebSocketHandler extends TextWebSocketHandler {
  private final AgentService agents;
  private final AgentSocketHub hub;
  private final ObjectMapper mapper;

  @Override
  public void afterConnectionEstablished(WebSocketSession session) throws Exception {
    String token = attribute(session, AgentSocketHub.ATTR_TOKEN);
    String agentId = attribute(session, AgentSocketHub.ATTR_AGENT_ID);
    hub.attach(agentId, token, session);
    try {
      AgentProtocol.Registered registered = agents.register(
          token, new AgentProtocol.RegisterRequest("agent.register", agentId));
      hub.send(agentId, registered);
      agents.offerJobToWorker(agentId);
    } catch (RuntimeException error) {
      sendError(agentId, error);
      session.close(CloseStatus.POLICY_VIOLATION);
    }
  }

  @Override
  protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
    String token = attribute(session, AgentSocketHub.ATTR_TOKEN);
    String agentId = attribute(session, AgentSocketHub.ATTR_AGENT_ID);
    JsonNode root;
    try {
      root = mapper.readTree(message.getPayload());
    } catch (Exception error) {
      hub.send(agentId, AgentProtocol.SocketError.of("invalid_request", "Invalid websocket payload"));
      return;
    }
    String type = root.path("type").asText("");
    try {
      switch (type) {
        case "agent.heartbeat" -> hub.send(
            agentId,
            agents.heartbeat(token, mapper.treeToValue(root, AgentProtocol.HeartbeatRequest.class)));
        case "agent.events" -> agents.ingestEvents(
            token, mapper.treeToValue(root, AgentProtocol.StreamEventsRequest.class));
        case "agent.message" -> agents.postReply(
            token, mapper.treeToValue(root, AgentProtocol.ReplyRequest.class));
        case "agent.sleep" -> {
          agents.sleepFromWorker(token, mapper.treeToValue(root, AgentProtocol.SleepRequest.class));
          session.close(CloseStatus.NORMAL);
        }
        case "agent.model_environment" -> hub.send(agentId, agents.modelEnvironment(token));
        default -> hub.send(
            agentId, AgentProtocol.SocketError.of("unknown_type", "Unsupported websocket message type"));
      }
    } catch (ApiException error) {
      sendError(agentId, error);
    } catch (RuntimeException error) {
      log.warn("Agent websocket handler failed for {}", agentId, error);
      sendError(agentId, error);
    }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
    hub.detach(session);
  }

  @Override
  public void handleTransportError(WebSocketSession session, Throwable exception) {
    hub.detach(session);
  }

  private void sendError(String agentId, RuntimeException error) {
    String code = error instanceof ApiException api ? api.getCode() : "agent_socket_error";
    String message = Optional.ofNullable(error.getMessage()).filter(value -> !value.isBlank())
        .orElse("Agent websocket request failed");
    hub.send(agentId, AgentProtocol.SocketError.of(code, message));
  }

  private static String attribute(WebSocketSession session, String key) {
    Object value = session.getAttributes().get(key);
    if (!(value instanceof String text) || text.isBlank()) {
      throw new ApiException("agent_unauthenticated", "Agent websocket session is missing credentials", 401);
    }
    return text;
  }
}
