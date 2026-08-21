package com.kross.fleet;

import com.kross.agent.AgentMapper;
import com.kross.agent.entity.Agent;
import com.kross.api.ApiException;
import com.kross.config.KrossProperties;
import com.kross.observability.RequestLogContext;
import com.kross.orchestrator.ContainerBackend;
import com.kross.orchestrator.WorkerStorageMode;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@Primary
@RequiredArgsConstructor
@ConditionalOnProperty(name = "kross.worker-runtime", havingValue = "cluster")
public class NodeFleetBackend implements ContainerBackend {
  private final NodeHub hub;
  private final AgentMapper agents;
  private final KrossProperties properties;

  @Override
  public void ensureVolume(String agentId) {
    // The selected node creates the JuiceFS directory or Docker volume locally.
  }

  @Override
  public BackendHandle start(StartRequest request) {
    RequestLogContext.put(RequestLogContext.AGENT_ID, request.agentId());
    Optional<String> previous = currentNode(request.agentId());
    String nodeId = pickNode(request.agentId());
    RequestLogContext.put(RequestLogContext.NODE_ID, nodeId);
    log.info("Dispatching agent start to node");
    previous.filter(id -> !id.equals(nodeId)).filter(hub::isOnline).ifPresent(oldNode -> {
      try {
        hub.request(oldNode, new NodeProtocol.StopCommand(UUID.randomUUID().toString(), request.agentId()));
      } catch (RuntimeException ignored) {
        // best-effort stop on the previous node before the workspace floats
      }
    });
    NodeProtocol.Result result = hub.request(nodeId, NodeProtocol.StartCommand.of(UUID.randomUUID().toString(), request));
    requireOk(result);
    return new BackendHandle(
        request.agentId(),
        Optional.ofNullable(result.containerId()).orElse(""),
        Optional.ofNullable(result.containerName()).orElse(""),
        Optional.ofNullable(result.volumeName()).orElse(""),
        nodeId);
  }

  @Override
  public void stop(String agentId) {
    currentNode(agentId).filter(hub::isOnline).ifPresent(nodeId -> {
      NodeProtocol.Result result = hub.request(nodeId, new NodeProtocol.StopCommand(UUID.randomUUID().toString(), agentId));
      requireOk(result);
    });
  }

  @Override
  public Optional<BackendInspection> inspect(String agentId) {
    return currentNode(agentId).filter(nodeId -> hub.isHealthy(nodeId, requiresJuicefs())).flatMap(nodeId -> {
      NodeProtocol.Result result = hub.request(nodeId, new NodeProtocol.InspectCommand(UUID.randomUUID().toString(), agentId));
      if (!result.ok() || Optional.ofNullable(result.state()).filter(value -> !value.isBlank()).isEmpty()) {
        return Optional.empty();
      }
      return Optional.of(new BackendInspection(
          new BackendHandle(
              agentId,
              Optional.ofNullable(result.containerId()).orElse(""),
              Optional.ofNullable(result.containerName()).orElse(""),
              Optional.ofNullable(result.volumeName()).orElse(""),
              nodeId),
          result.state(),
          Optional.ofNullable(result.exitCode())));
    });
  }

  @Override
  public boolean health() {
    return hub.pickLeastLoaded(requiresJuicefs()).isPresent();
  }

  private String pickNode(String agentId) {
    boolean juicefs = requiresJuicefs();
    return currentNode(agentId)
        .filter(nodeId -> hub.isHealthy(nodeId, juicefs))
        .or(() -> hub.pickLeastLoaded(juicefs))
        .orElseThrow(() -> {
          log.warn("No healthy worker node is available juicefsRequired={}", juicefs);
          return new ApiException(
              "node_unavailable",
              juicefs
                  ? "No healthy JuiceFS worker node is online"
                  : "No healthy worker node is online",
              503);
        });
  }

  private Optional<String> currentNode(String agentId) {
    return agents.findByIdOnly(agentId)
        .map(Agent::getNodeId)
        .flatMap(nodeId -> Optional.ofNullable(nodeId).filter(value -> !value.isBlank()));
  }

  private boolean requiresJuicefs() {
    return WorkerStorageMode.from(properties.getWorkerStorage()) == WorkerStorageMode.JUICEFS;
  }

  private static void requireOk(NodeProtocol.Result result) {
    if (!result.ok()) {
      throw new ApiException(
          "agent_start_failed",
          Optional.ofNullable(result.error()).filter(value -> !value.isBlank()).orElse("Worker node command failed"),
          500);
    }
  }
}
