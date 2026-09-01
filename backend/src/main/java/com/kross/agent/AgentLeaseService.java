package com.kross.agent;

import com.kross.agent.entity.Agent;
import com.kross.channel.AgentSocketHub;
import com.kross.channel.WorkerOfferBus;
import com.kross.config.KrossProperties;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import com.kross.observability.RequestLogContext;
import com.kross.orchestrator.ContainerBackend;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
@RequiredArgsConstructor
public class AgentLeaseService {
  private final AgentMapper agents;
  private final OrganizationAccess access;
  private final ContainerBackend containers;
  private final KrossProperties properties;
  private final AgentSocketHub sockets;
  private final WorkerOfferBus offers;
  private final AgentMemoryService memories;
  private final AgentRuntimeOps runtime;
  private final AgentTransactions transactions;

  public void sleepIdleAgents() {
    Instant idleBefore = Instant.now().minusMillis(properties.getAgent().getIdleMs());
    for (Agent agent : agents.listIdleRunning(idleBefore)) {
      try {
        if (sockets.isConnected(agent.getId()) && memories.hasPendingExtract(agent)) {
          memories.consolidateAsync(agent);
          continue;
        }
        runtime.sleep(agent);
      } catch (RuntimeException ignored) {
        // best-effort idle stop; next tick retries
      }
    }
  }

  public void reconcileRuntimeAgents() {
    for (Agent agent : agents.listRuntimeAgents()) {
      RequestLogContext.bindAgent(agent);
      Optional<ContainerBackend.BackendInspection> inspection = containers.inspect(agent.getId());
      if (inspection.filter(state -> "running".equals(state.state())).isPresent()) {
        ContainerBackend.BackendHandle handle = inspection.get().handle();
        runtime.tx().executeWithoutResult(status -> runtime.markRunning(agent, handle));
        continue;
      }
      if (runtime.stillStarting(agent)) {
        continue;
      }
      boolean shouldWake = Boolean.TRUE.equals(runtime.tx().execute(status -> {
        agents.requeueInterruptedMessages(agent.getId());
        agent.setStatus("stopped");
        agent.setContainerId(null);
        agent.setLastError("Agent worker exited unexpectedly");
        agents.updateRuntime(agent);
        return agents.hasQueued(agent.getId());
      }));
      if (!shouldWake) {
        continue;
      }
      try {
        runtime.wake(agent);
      } catch (RuntimeException error) {
        log.warn("Failed to wake agent after interrupt: {}", error.getMessage());
      }
    }
  }

  @Transactional
  public void recoverExpiredJobLeases() {
    List<String> recoveredAgents = agents.recoverExpiredLeases(
        Instant.now(), properties.getAgent().getJobMaxAttempts());
    if (!recoveredAgents.isEmpty()) {
      log.warn("Recovered expired job leases for {} agents", recoveredAgents.size());
      transactions.afterCommit(() -> recoveredAgents.forEach(this::offerJobToWorker));
    }
  }

  @Transactional
  public void cleanupDeliveryReceipts() {
    agents.deleteDeliveryReceiptsBefore(Instant.now().minus(Duration.ofDays(1)));
  }

  @Transactional
  public void releaseClaimedJob(String agentId, String messageId, String leaseId) {
    if (agents.releaseLeasedMessage(agentId, messageId, leaseId) == 1) {
      transactions.afterCommit(() -> offerJobToWorker(agentId));
    }
  }

  public void offerJobToWorker(String agentId) {
    offers.offer(agentId);
  }

  public void scheduleWake(String organizationId) {
    try {
      OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
      RequestLogContext.put(RequestLogContext.ORGANIZATION_ID, context.organizationId());
      RequestLogContext.put(RequestLogContext.USER_ID, context.userId());
      Thread.ofVirtual().start(RequestLogContext.propagate(() -> runtime.wakeQuietly(runtime.ensure(context))));
    } catch (RuntimeException error) {
      log.warn("Failed to schedule agent wake: {}", error.getMessage());
    }
  }

  public void scheduleWakeFor(String organizationId, String userId) {
    RequestLogContext.put(RequestLogContext.ORGANIZATION_ID, organizationId);
    RequestLogContext.put(RequestLogContext.USER_ID, userId);
    Thread.ofVirtual().start(RequestLogContext.propagate(() -> {
      try {
        runtime.wakeQuietly(runtime.ensure(organizationId, userId));
      } catch (RuntimeException error) {
        log.warn("Failed to wake agent workspace: {}", error.getMessage());
      }
    }));
  }

  public void wakeWorkspaceQuietly(String organizationId) {
    try {
      OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
      runtime.wake(runtime.ensure(context));
    } catch (RuntimeException error) {
      log.warn("Failed to wake agent workspace: {}", error.getMessage());
    }
  }
}
