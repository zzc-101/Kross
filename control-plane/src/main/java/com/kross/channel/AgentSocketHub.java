package com.kross.channel;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.AgentService;
import com.kross.agent.dto.AgentProtocol;
import java.io.IOException;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

@Slf4j
@Component
public class AgentSocketHub {
  public static final String ATTR_TOKEN = "agentToken";
  public static final String ATTR_AGENT_ID = "agentId";

  private final ObjectMapper mapper;
  private final AgentService agents;
  private final ConcurrentHashMap<String, SocketState> byAgent = new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, String> sessionToAgent = new ConcurrentHashMap<>();

  public AgentSocketHub(ObjectMapper mapper, @Lazy AgentService agents) {
    this.mapper = mapper;
    this.agents = agents;
  }

  public void attach(String agentId, String token, WebSocketSession session) {
    SocketState state = byAgent.computeIfAbsent(agentId, key -> new SocketState());
    synchronized (state.lock) {
      if (state.session != null
          && state.session.isOpen()
          && !state.session.getId().equals(session.getId())) {
        try {
          state.session.close(CloseStatus.SESSION_NOT_RELIABLE);
        } catch (IOException ignored) {
          // replaced by the new connection
        }
      }
      state.session = session;
      state.token = token;
      state.busy = false;
    }
    sessionToAgent.put(session.getId(), agentId);
  }

  public void detach(WebSocketSession session) {
    String agentId = sessionToAgent.remove(session.getId());
    if (agentId == null) {
      return;
    }
    SocketState state = byAgent.get(agentId);
    if (state == null) {
      return;
    }
    synchronized (state.lock) {
      if (state.session != null && state.session.getId().equals(session.getId())) {
        byAgent.remove(agentId, state);
      }
    }
  }

  public void markIdle(String agentId) {
    SocketState state = byAgent.get(agentId);
    if (state == null) {
      return;
    }
    synchronized (state.lock) {
      state.busy = false;
    }
  }

  public void offerJob(String agentId) {
    SocketState state = byAgent.get(agentId);
    if (state == null) {
      return;
    }
    synchronized (state.lock) {
      if (state.session == null || !state.session.isOpen() || state.busy) {
        return;
      }
      Optional<AgentProtocol.Job> job;
      try {
        job = agents.claimIfIdle(state.token);
      } catch (RuntimeException error) {
        log.warn("Failed to claim a job for agent {}", agentId, error);
        return;
      }
      if (job.isEmpty()) {
        return;
      }
      state.busy = true;
      sendLocked(state, job.get());
    }
  }

  public void send(String agentId, Object payload) {
    SocketState state = byAgent.get(agentId);
    if (state == null) {
      return;
    }
    synchronized (state.lock) {
      sendLocked(state, payload);
    }
  }

  private void sendLocked(SocketState state, Object payload) {
    if (state.session == null || !state.session.isOpen()) {
      return;
    }
    try {
      state.session.sendMessage(new TextMessage(mapper.writeValueAsString(payload)));
    } catch (IOException error) {
      log.warn("Failed to send a websocket frame to agent {}", sessionToAgent.get(state.session.getId()), error);
      try {
        state.session.close(CloseStatus.SERVER_ERROR);
      } catch (IOException ignored) {
        // close is best-effort
      }
    }
  }

  private static final class SocketState {
    private final Object lock = new Object();
    private WebSocketSession session;
    private String token;
    private boolean busy;
  }
}
