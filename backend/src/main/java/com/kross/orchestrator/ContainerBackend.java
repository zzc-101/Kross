package com.kross.orchestrator;

import java.util.List;
import java.util.Optional;

public interface ContainerBackend {
  BackendHandle launch(RunLaunchRequest request);

  BackendInspection inspect(BackendHandle handle);

  void terminate(BackendHandle handle);

  void cancel(String runId, int generation);

  void remove(BackendHandle handle);

  List<ManagedExecution> listManaged();

  int reapInfrastructureOrphans();

  boolean health();

  record RunLaunchRequest(
      String runId,
      int generation,
      String leaseId,
      String runToken,
      String runSpecUrl,
      String tokenExpiresAt,
      ResourceLimits resourceLimits,
      String networkAccess) {}

  record ResourceLimits(
      int cpuMillis, long memoryBytes, int maxPids, long diskBytes, long maxDurationMs) {}

  record BackendHandle(
      String runId,
      int generation,
      String containerId,
      String containerName,
      String volumeName,
      Optional<String> networkName,
      String deadlineAt) {}

  record BackendInspection(
      BackendHandle handle,
      String state,
      Optional<String> startedAt,
      Optional<String> finishedAt,
      Optional<Integer> exitCode) {}

  record ManagedExecution(BackendInspection inspection) {}
}
