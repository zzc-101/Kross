package com.kross.execution;

import com.fasterxml.jackson.databind.JsonNode;
import com.kross.config.KrossProperties;
import com.kross.execution.entity.QueuedLaunch;
import com.kross.execution.entity.RunLease;
import com.kross.orchestrator.ContainerBackend;
import com.kross.orchestrator.ContainerBackend.ResourceLimits;
import com.kross.orchestrator.ContainerBackend.RunLaunchRequest;
import com.kross.support.Jsons;
import com.kross.support.Policies;
import com.kross.worker.WorkerControlService;
import com.kross.worker.dto.WorkerProtocol.IssuedRunToken;
import java.net.URI;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
public class RunScheduler {
  private final ExecutionMapper execution;
  private final WorkerControlService workers;
  private final ContainerBackend containers;
  private final KrossProperties properties;
  private final AtomicBoolean running = new AtomicBoolean(false);

  @Scheduled(fixedDelayString = "${kross.scheduler.poll-ms:1000}")
  public void tick() {
    try {
      runOnce();
    } catch (RuntimeException error) {
      log.warn("Run scheduler tick failed: {}", error.getMessage());
    }
  }

  public boolean runOnce() {
    if (!running.compareAndSet(false, true)) {
      return false;
    }
    RunLease lease = null;
    try {
      lease = execution.claimLease(
              properties.getSchedulerOwner(), properties.getScheduler().getLeaseDurationMs())
          .orElse(null);
      if (lease == null) {
        return false;
      }
      LaunchPlan launch = loadLaunch(lease);
      IssuedRunToken issued = workers.issueRunToken(lease, properties.getScheduler().getTokenTtlMs());
      containers.launch(new RunLaunchRequest(
          lease.getRunId(),
          lease.getGeneration(),
          lease.getLeaseId(),
          issued.token(),
          URI.create(properties.getPublicBaseUrl()).resolve("/internal/v2/workers/register").toString(),
          issued.expiresAt(),
          launch.resourceLimits(),
          launch.networkAccess()));
      if (execution.markProvisioning(lease.getOrganizationId(), lease.getRunId(), lease.getGeneration()) != 1) {
        try {
          containers.cancel(lease.getRunId(), lease.getGeneration());
        } catch (RuntimeException ignored) {
          // best-effort terminate after a lost queued run
        }
        execution.releaseLease(
            lease.getOrganizationId(),
            lease.getLeaseId(),
            lease.getOwner(),
            lease.getGeneration(),
            0);
        return false;
      }
      return true;
    } catch (RuntimeException error) {
      if (lease != null) {
        execution.revokeTokensForLease(
            lease.getOrganizationId(), lease.getRunId(), lease.getGeneration(), lease.getLeaseId());
        try {
          execution.releaseLease(
              lease.getOrganizationId(),
              lease.getLeaseId(),
              lease.getOwner(),
              lease.getGeneration(),
              properties.getScheduler().getRetryDelayMs());
        } catch (RuntimeException ignored) {
          // lease may already have been released
        }
      }
      throw error;
    } finally {
      running.set(false);
    }
  }

  public void cancel(String runId, String organizationId) {
    Optional<Integer> generation = execution.leasedGenerationForCancelling(organizationId, runId);
    if (generation.isEmpty() || generation.get() < 1) {
      execution.markCancelledIfCancelling(organizationId, runId);
      return;
    }
    containers.cancel(runId, generation.get());
  }

  private LaunchPlan loadLaunch(RunLease lease) {
    QueuedLaunch row = execution.findQueuedLaunch(lease.getOrganizationId(), lease.getRunId())
        .orElseThrow(() -> new IllegalStateException("Queued Run " + lease.getRunId() + " no longer exists"));
    JsonNode policy = Jsons.objectOrEmpty(row.getPermissionPolicy());
    JsonNode limits = row.getResourceLimits() != null && row.getResourceLimits().isObject()
        ? row.getResourceLimits()
        : Policies.defaultResourceLimits();
    String networkAccess = policy.path("networkAccess").asText("");
    if (!List.of("restricted", "connector_proxy_only", "disabled").contains(networkAccess)) {
      networkAccess = policy.path("allowNetworkAccess").asBoolean(false) ? "restricted" : "disabled";
    }
    return new LaunchPlan(
        new ResourceLimits(
            limits.path("cpuMillis").asInt(1_000),
            limits.path("memoryBytes").asLong(1_073_741_824L),
            limits.path("maxPids").asInt(256),
            limits.path("diskBytes").asLong(5_368_709_120L),
            limits.path("maxDurationMs").asLong(1_800_000)),
        networkAccess);
  }

  private record LaunchPlan(ResourceLimits resourceLimits, String networkAccess) {}
}
