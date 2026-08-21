package com.kross.fleet;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.api.ApiException;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

@Slf4j
@Component
@ConditionalOnProperty(name = "kross.worker-runtime", havingValue = "cluster")
public class NodeHub {
  static final String ATTR_NODE_ID = "nodeId";

  private final ObjectMapper mapper;
  private final WorkerNodeMapper nodes;
  private final ConcurrentHashMap<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, String> sessionToNode = new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, CompletableFuture<NodeProtocol.Result>> pending = new ConcurrentHashMap<>();

  public NodeHub(ObjectMapper mapper, WorkerNodeMapper nodes) {
    this.mapper = mapper;
    this.nodes = nodes;
  }

  public void attach(String nodeId, String hostname, boolean juicefsOk, int runningAgents, WebSocketSession session) {
    WebSocketSession previous = sessions.put(nodeId, session);
    if (previous != null && previous.isOpen() && !previous.getId().equals(session.getId())) {
      sessionToNode.remove(previous.getId());
      try {
        previous.close(CloseStatus.SESSION_NOT_RELIABLE);
      } catch (IOException ignored) {
        // replaced by the new connection
      }
    }
    sessionToNode.put(session.getId(), nodeId);
    WorkerNode row = new WorkerNode();
    row.setId(nodeId);
    row.setHostname(Optional.ofNullable(hostname).filter(value -> !value.isBlank()).orElse(nodeId));
    row.setStatus("online");
    row.setJuicefsOk(juicefsOk);
    row.setRunningAgents(runningAgents);
    row.setLastSeenAt(Instant.now());
    nodes.upsert(row);
  }

  public void heartbeat(String nodeId, boolean juicefsOk, int runningAgents) {
    WorkerNode row = nodes.findById(nodeId).orElseGet(WorkerNode::new);
    row.setId(nodeId);
    row.setHostname(Optional.ofNullable(row.getHostname()).filter(value -> !value.isBlank()).orElse(nodeId));
    row.setStatus("online");
    row.setJuicefsOk(juicefsOk);
    row.setRunningAgents(runningAgents);
    row.setLastSeenAt(Instant.now());
    nodes.upsert(row);
  }

  public void detach(WebSocketSession session) {
    String nodeId = sessionToNode.remove(session.getId());
    if (nodeId == null) {
      return;
    }
    sessions.remove(nodeId, session);
    nodes.markOffline(nodeId);
  }

  public boolean isOnline(String nodeId) {
    return Optional.ofNullable(sessions.get(nodeId)).filter(WebSocketSession::isOpen).isPresent();
  }

  public boolean isHealthy(String nodeId, boolean requireJuicefs) {
    if (!isOnline(nodeId)) {
      return false;
    }
    return nodes.findById(nodeId)
        .filter(node -> "online".equals(node.getStatus()))
        .filter(node -> !requireJuicefs || node.isJuicefsOk())
        .isPresent();
  }

  public Optional<String> pickLeastLoaded(boolean requireJuicefs) {
    Instant since = Instant.now().minus(Duration.ofSeconds(30));
    return nodes.listOnlineSince(since).stream()
        .filter(node -> isOnline(node.getId()))
        .filter(node -> !requireJuicefs || node.isJuicefsOk())
        .map(WorkerNode::getId)
        .findFirst();
  }

  public NodeProtocol.Result request(String nodeId, Object payload) {
    String requestId = switch (payload) {
      case NodeProtocol.StartCommand command -> command.requestId();
      case NodeProtocol.StopCommand command -> command.requestId();
      case NodeProtocol.InspectCommand command -> command.requestId();
      default -> UUID.randomUUID().toString();
    };
    CompletableFuture<NodeProtocol.Result> future = new CompletableFuture<>();
    pending.put(requestId, future);
    try {
      send(nodeId, payload);
      return future.get(60, TimeUnit.SECONDS);
    } catch (TimeoutException error) {
      throw new ApiException("node_timeout", "Worker node did not respond in time", 503);
    } catch (ApiException error) {
      throw error;
    } catch (Exception error) {
      throw new ApiException("node_unavailable", Optional.ofNullable(error.getMessage()).orElse("Worker node failed"), 503);
    } finally {
      pending.remove(requestId);
    }
  }

  public void complete(NodeProtocol.Result result) {
    Optional.ofNullable(pending.get(result.requestId())).ifPresent(future -> future.complete(result));
  }

  public void markStaleOffline() {
    nodes.markStaleOffline(Instant.now().minus(Duration.ofSeconds(30)));
  }

  private void send(String nodeId, Object payload) {
    WebSocketSession session = Optional.ofNullable(sessions.get(nodeId))
        .filter(WebSocketSession::isOpen)
        .orElseThrow(() -> new ApiException("node_unavailable", "Worker node is offline", 503));
    try {
      session.sendMessage(new TextMessage(mapper.writeValueAsString(payload)));
    } catch (IOException error) {
      log.warn("Failed to send a command to node {}", nodeId, error);
      try {
        session.close(CloseStatus.SERVER_ERROR);
      } catch (IOException ignored) {
        // close is best-effort
      }
      throw new ApiException("node_unavailable", "Worker node is unreachable", 503);
    }
  }
}
