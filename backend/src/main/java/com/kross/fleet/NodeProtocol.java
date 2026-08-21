package com.kross.fleet;

import com.kross.orchestrator.ContainerBackend.ResourceLimits;
import com.kross.orchestrator.ContainerBackend.StartRequest;

public final class NodeProtocol {
  private NodeProtocol() {}

  public record Hello(
      String type,
      String nodeId,
      String hostname,
      boolean juicefsOk,
      int runningAgents) {
    public Hello(String nodeId, String hostname, boolean juicefsOk, int runningAgents) {
      this("node.hello", nodeId, hostname, juicefsOk, runningAgents);
    }
  }

  public record Heartbeat(
      String type,
      String nodeId,
      boolean juicefsOk,
      int runningAgents) {
    public Heartbeat(String nodeId, boolean juicefsOk, int runningAgents) {
      this("node.heartbeat", nodeId, juicefsOk, runningAgents);
    }
  }

  public record StartCommand(
      String type,
      String requestId,
      String agentId,
      String agentToken,
      String controlPlaneUrl,
      int cpuMillis,
      long memoryBytes,
      int maxPids) {
    public static StartCommand of(String requestId, StartRequest request) {
      ResourceLimits limits = request.resourceLimits();
      return new StartCommand(
          "node.start",
          requestId,
          request.agentId(),
          request.agentToken(),
          request.controlPlaneUrl(),
          limits.cpuMillis(),
          limits.memoryBytes(),
          limits.maxPids());
    }

    public StartRequest toStartRequest() {
      return new StartRequest(
          agentId,
          agentToken,
          controlPlaneUrl,
          new ResourceLimits(cpuMillis, memoryBytes, maxPids));
    }
  }

  public record StopCommand(String type, String requestId, String agentId) {
    public StopCommand(String requestId, String agentId) {
      this("node.stop", requestId, agentId);
    }
  }

  public record InspectCommand(String type, String requestId, String agentId) {
    public InspectCommand(String requestId, String agentId) {
      this("node.inspect", requestId, agentId);
    }
  }

  public record Result(
      String type,
      String requestId,
      boolean ok,
      String error,
      String containerId,
      String containerName,
      String volumeName,
      String state,
      Integer exitCode) {
    public static Result ok(String requestId, String containerId, String containerName, String volumeName, String state) {
      return new Result("node.result", requestId, true, null, containerId, containerName, volumeName, state, null);
    }

    public static Result failed(String requestId, String error) {
      return new Result("node.result", requestId, false, error, null, null, null, null, null);
    }
  }
}
