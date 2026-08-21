package com.kross.fleet;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.observability.RequestLogContext;
import java.util.Map;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Slf4j
@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = "kross.worker-runtime", havingValue = "cluster")
public class NodeWebSocketHandler extends TextWebSocketHandler {
  private final NodeHub hub;
  private final ObjectMapper mapper;

  @Override
  public void afterConnectionEstablished(WebSocketSession session) {
    // hello is the first text frame
  }

  @Override
  protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
    JsonNode root;
    try {
      root = mapper.readTree(message.getPayload());
    } catch (Exception error) {
      session.close(CloseStatus.BAD_DATA);
      return;
    }
    String type = root.path("type").asText("");
    String nodeId = Optional.ofNullable(session.getAttributes().get(NodeHub.ATTR_NODE_ID))
        .map(Object::toString)
        .orElse("");
    try (AutoCloseable ignored = RequestLogContext.overlay(
        nodeId.isBlank() ? Map.of() : Map.of(RequestLogContext.NODE_ID, nodeId))) {
      switch (type) {
        case "node.hello" -> {
          NodeProtocol.Hello hello = mapper.treeToValue(root, NodeProtocol.Hello.class);
          String id = Optional.ofNullable(hello.nodeId()).filter(value -> !value.isBlank()).orElse(nodeId);
          RequestLogContext.put(RequestLogContext.NODE_ID, id);
          hub.attach(id, hello.hostname(), hello.juicefsOk(), hello.runningAgents(), session);
          session.getAttributes().put(NodeHub.ATTR_NODE_ID, id);
        }
        case "node.heartbeat" -> {
          NodeProtocol.Heartbeat heartbeat = mapper.treeToValue(root, NodeProtocol.Heartbeat.class);
          hub.heartbeat(
              Optional.ofNullable(heartbeat.nodeId()).filter(value -> !value.isBlank()).orElse(nodeId),
              heartbeat.juicefsOk(),
              heartbeat.runningAgents());
        }
        case "node.result" -> hub.complete(mapper.treeToValue(root, NodeProtocol.Result.class));
        default -> log.warn("Unknown node websocket type {}", type);
      }
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
}
