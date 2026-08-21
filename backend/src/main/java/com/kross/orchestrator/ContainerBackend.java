package com.kross.orchestrator;

import java.util.Optional;

public interface ContainerBackend {
  void ensureVolume(String agentId);

  BackendHandle start(StartRequest request);

  void stop(String agentId);

  Optional<BackendInspection> inspect(String agentId);

  boolean health();

  record StartRequest(
      String agentId,
      String agentToken,
      String controlPlaneUrl,
      ResourceLimits resourceLimits) {}

  record ResourceLimits(int cpuMillis, long memoryBytes, int maxPids) {}

  record BackendHandle(
      String agentId,
      String containerId,
      String containerName,
      String volumeName,
      String nodeId) {}

  record BackendInspection(
      BackendHandle handle,
      String state,
      Optional<Integer> exitCode) {}
}
