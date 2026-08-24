package com.kross.channel;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.AgentService;
import com.kross.agent.dto.AgentProtocol;
import com.kross.api.ApiException;
import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
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
  private final ConcurrentHashMap<String, PendingCommand> pending = new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, CopyOnWriteArrayList<CompletableFuture<Void>>> connectWaiters =
      new ConcurrentHashMap<>();

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
    }
    sessionToAgent.put(session.getId(), agentId);
    signalConnected(agentId);
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
        failPending(agentId, "Agent worker disconnected");
      }
    }
  }

  public boolean isConnected(String agentId) {
    SocketState state = byAgent.get(agentId);
    if (state == null) {
      return false;
    }
    synchronized (state.lock) {
      return state.session != null && state.session.isOpen();
    }
  }

  public boolean awaitConnected(String agentId, Duration timeout) {
    if (isConnected(agentId)) {
      return true;
    }
    CompletableFuture<Void> waiter = new CompletableFuture<>();
    connectWaiters.computeIfAbsent(agentId, key -> new CopyOnWriteArrayList<>()).add(waiter);
    if (isConnected(agentId)) {
      waiter.complete(null);
    }
    try {
      waiter.get(Math.max(timeout.toMillis(), 1), TimeUnit.MILLISECONDS);
      return true;
    } catch (TimeoutException ignored) {
      return isConnected(agentId);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      return isConnected(agentId);
    } catch (ExecutionException ignored) {
      return isConnected(agentId);
    } finally {
      CopyOnWriteArrayList<CompletableFuture<Void>> waiters = connectWaiters.get(agentId);
      if (waiters != null) {
        waiters.remove(waiter);
        if (waiters.isEmpty()) {
          connectWaiters.remove(agentId, waiters);
        }
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

  public void sendRequired(String agentId, Object payload) {
    SocketState state = byAgent.get(agentId);
    if (state == null) {
      throw ApiException.conflict("agent_offline", "Agent worker is not connected");
    }
    synchronized (state.lock) {
      if (state.session == null || !state.session.isOpen()) {
        throw ApiException.conflict("agent_offline", "Agent worker is not connected");
      }
      if (!sendLocked(state, payload)) {
        throw ApiException.conflict("agent_offline", "Agent worker did not accept the message");
      }
    }
  }

  public Map<String, Object> requestCommand(
      String agentId, String name, Map<String, Object> payload, Duration timeout) {
    String commandId = UUID.randomUUID().toString();
    CompletableFuture<AgentProtocol.CommandResult> future = new CompletableFuture<>();
    pending.put(commandId, new PendingCommand(agentId, future));
    SocketState state = byAgent.get(agentId);
    if (state == null) {
      pending.remove(commandId);
      throw ApiException.conflict("agent_offline", "Agent worker is not connected");
    }
    synchronized (state.lock) {
      if (state.session == null || !state.session.isOpen()) {
        pending.remove(commandId);
        throw ApiException.conflict("agent_offline", "Agent worker is not connected");
      }
      sendLocked(state, new AgentProtocol.Command(commandId, name, payload));
    }
    try {
      AgentProtocol.CommandResult result = future.get(Math.max(timeout.toMillis(), 1), TimeUnit.MILLISECONDS);
      if (result == null || !result.ok()) {
        throw ApiException.invalidRequest(
            Optional.ofNullable(result).map(AgentProtocol.CommandResult::error).filter(value -> !value.isBlank())
                .orElse("Workspace command failed"));
      }
      return Optional.ofNullable(result.payload()).orElse(Map.of());
    } catch (TimeoutException timeoutError) {
      throw ApiException.conflict("agent_timeout", "Agent worker did not respond");
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw ApiException.conflict("agent_timeout", "Agent worker request was interrupted");
    } catch (ExecutionException error) {
      Throwable cause = Optional.ofNullable(error.getCause()).orElse(error);
      if (cause instanceof ApiException api) {
        throw api;
      }
      throw ApiException.conflict("agent_offline", cause.getMessage());
    } finally {
      pending.remove(commandId);
    }
  }

  public void completeCommand(String agentId, AgentProtocol.CommandResult result) {
    if (result == null || result.commandId() == null || result.commandId().isBlank()) {
      return;
    }
    PendingCommand command = pending.get(result.commandId());
    if (command == null || !agentId.equals(command.agentId)) {
      return;
    }
    pending.remove(result.commandId(), command);
    command.future.complete(result);
  }

  private void signalConnected(String agentId) {
    List<CompletableFuture<Void>> waiters = connectWaiters.remove(agentId);
    if (waiters == null) {
      return;
    }
    for (CompletableFuture<Void> waiter : waiters) {
      waiter.complete(null);
    }
  }

  private void failPending(String agentId, String message) {
    pending.entrySet().removeIf(entry -> {
      if (!agentId.equals(entry.getValue().agentId)) {
        return false;
      }
      entry.getValue().future.completeExceptionally(ApiException.conflict("agent_offline", message));
      return true;
    });
  }

  private boolean sendLocked(SocketState state, Object payload) {
    if (state.session == null || !state.session.isOpen()) {
      return false;
    }
    try {
      state.session.sendMessage(new TextMessage(mapper.writeValueAsString(payload)));
      return true;
    } catch (IOException error) {
      log.warn("Failed to send a websocket frame to agent {}", sessionToAgent.get(state.session.getId()), error);
      try {
        state.session.close(CloseStatus.SERVER_ERROR);
      } catch (IOException ignored) {
        // close is best-effort
      }
      return false;
    }
  }

  private static final class SocketState {
    private final Object lock = new Object();
    private WebSocketSession session;
    private String token;
    private boolean busy;
  }

  private record PendingCommand(String agentId, CompletableFuture<AgentProtocol.CommandResult> future) {}
}
