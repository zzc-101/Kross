package com.kross.orchestrator;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.command.InspectContainerResponse;
import com.github.dockerjava.api.exception.NotFoundException;
import com.github.dockerjava.api.model.Bind;
import com.github.dockerjava.api.model.Capability;
import com.github.dockerjava.api.model.HostConfig;
import com.github.dockerjava.api.model.RestartPolicy;
import com.github.dockerjava.api.model.Volume;
import com.github.dockerjava.core.DefaultDockerClientConfig;
import com.github.dockerjava.core.DockerClientImpl;
import com.github.dockerjava.httpclient5.ApacheDockerHttpClient;
import com.kross.api.ApiException;
import com.kross.config.KrossProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Component;

@Component
public class DockerContainerBackend implements ContainerBackend {
  static final String LABEL_PREFIX = "dev.kross.run";
  static final String RUN_LABEL = LABEL_PREFIX + ".id";
  static final String GENERATION_LABEL = LABEL_PREFIX + ".generation";
  static final String DEADLINE_LABEL = LABEL_PREFIX + ".deadline";
  static final String MANAGER_LABEL = LABEL_PREFIX + ".manager";
  static final String VOLUME_LABEL = LABEL_PREFIX + ".volume";
  static final String NETWORK_LABEL = LABEL_PREFIX + ".network";

  private final DockerClient docker;
  private final KrossProperties properties;

  public DockerContainerBackend(KrossProperties properties) {
    this.properties = properties;
    var config = DefaultDockerClientConfig.createDefaultConfigBuilder().build();
    var http = new ApacheDockerHttpClient.Builder()
        .dockerHost(config.getDockerHost())
        .connectionTimeout(Duration.ofSeconds(5))
        .responseTimeout(Duration.ofSeconds(30))
        .build();
    this.docker = DockerClientImpl.getInstance(config, http);
  }

  @Override
  public BackendHandle launch(RunLaunchRequest request) {
    assertSafe(request);
    String controlPlane = properties.getControlPlaneContainer()
        .orElseThrow(() -> new ApiException(
            "CONTROL_PLANE_PEER_REQUIRED",
            "Worker 必须配置受限控制面容器以完成注册和心跳",
            500));
    Names names = names(request.runId(), request.generation());
    String deadlineAt = Instant.now().plusMillis(request.resourceLimits().maxDurationMs()).toString();
    Map<String, String> labels = labels(request.runId(), request.generation(), deadlineAt);
    boolean volumeCreated = false;
    boolean networkCreated = false;
    String containerId = null;
    try {
      docker.createVolumeCmd()
          .withName(names.volumeName)
          .withLabels(with(labels, VOLUME_LABEL, "true"))
          .withDriver("local")
          .withDriverOpts(Map.of(
              "type", "tmpfs",
              "device", "tmpfs",
              "o", "size=" + request.resourceLimits().diskBytes() + ",uid=1000,gid=1000,mode=0700"))
          .exec();
      volumeCreated = true;
      docker.createNetworkCmd()
          .withName(names.networkName)
          .withDriver("bridge")
          .withInternal(!"restricted".equals(request.networkAccess()))
          .withCheckDuplicate(true)
          .withLabels(with(labels, NETWORK_LABEL, "true"))
          .exec();
      networkCreated = true;
      connect(names.networkName, controlPlane, List.of("kross-server", "server"));
      properties.getObjectStoreContainer().ifPresent(container ->
          connect(names.networkName, container, List.of("minio")));
      HostConfig hostConfig = HostConfig.newHostConfig()
          .withBinds(new Bind(names.volumeName, new Volume("/work")))
          .withNetworkMode(names.networkName)
          .withMemory(request.resourceLimits().memoryBytes())
          .withMemorySwap(request.resourceLimits().memoryBytes())
          .withNanoCPUs(request.resourceLimits().cpuMillis() * 1_000_000L)
          .withPidsLimit((long) request.resourceLimits().maxPids())
          .withReadonlyRootfs(true)
          .withCapDrop(Capability.ALL)
          .withSecurityOpts(List.of("no-new-privileges:true"))
          .withOomKillDisable(false)
          .withInit(true)
          .withAutoRemove(false)
          .withRestartPolicy(RestartPolicy.noRestart())
          .withTmpFs(Map.of(
              "/tmp", "rw,noexec,nosuid,nodev,size=67108864,uid=1000,gid=1000,mode=0700",
              "/run", "rw,noexec,nosuid,nodev,size=16777216,uid=1000,gid=1000,mode=0700"));
      containerId = docker.createContainerCmd(properties.getWorkerImage())
          .withName(names.containerName)
          .withUser("1000:1000")
          .withEnv(
              "KROSS_RUN_ID=" + request.runId(),
              "KROSS_GENERATION=" + request.generation(),
              "KROSS_LEASE_ID=" + request.leaseId(),
              "KROSS_RUN_TOKEN=" + request.runToken(),
              "KROSS_RUN_SPEC_URL=" + request.runSpecUrl(),
              "KROSS_RUN_TOKEN_EXPIRES_AT=" + request.tokenExpiresAt(),
              "KROSS_PHYSICAL_WORK_ROOT=/work")
          .withLabels(labels)
          .withWorkingDir("/work")
          .withStopTimeout(15)
          .withHostConfig(hostConfig)
          .exec()
          .getId();
      docker.startContainerCmd(containerId).exec();
      return new BackendHandle(
          request.runId(), request.generation(), containerId, names.containerName,
          names.volumeName, Optional.of(names.networkName), deadlineAt);
    } catch (RuntimeException error) {
      if (containerId != null) {
        try {
          docker.removeContainerCmd(containerId).withForce(true).exec();
        } catch (RuntimeException ignored) {
          // best-effort cleanup
        }
      }
      if (networkCreated) {
        removeNetwork(names.networkName);
      }
      if (volumeCreated) {
        try {
          docker.removeVolumeCmd(names.volumeName).exec();
        } catch (RuntimeException ignored) {
          // best-effort cleanup
        }
      }
      throw error;
    }
  }

  @Override
  public BackendInspection inspect(BackendHandle handle) {
    try {
      InspectContainerResponse state = docker.inspectContainerCmd(handle.containerId()).exec();
      boolean running = Boolean.TRUE.equals(state.getState().getRunning());
      String status = Optional.ofNullable(state.getState().getStatus()).orElse("");
      String mapped = running ? "running" : "created".equals(status) ? "created" : "exited";
      return new BackendInspection(
          handle,
          mapped,
          normalize(state.getState().getStartedAt()),
          normalize(state.getState().getFinishedAt()),
          running ? Optional.empty() : Optional.ofNullable(state.getState().getExitCode()));
    } catch (NotFoundException error) {
      return new BackendInspection(handle, "missing", Optional.empty(), Optional.empty(), Optional.empty());
    }
  }

  @Override
  public void terminate(BackendHandle handle) {
    try {
      InspectContainerResponse state = docker.inspectContainerCmd(handle.containerId()).exec();
      if (Boolean.TRUE.equals(state.getState().getRunning())) {
        docker.stopContainerCmd(handle.containerId()).withTimeout(15).exec();
      }
    } catch (NotFoundException ignored) {
      // already gone
    }
  }

  @Override
  public void cancel(String runId, int generation) {
    BackendHandle handle = listManaged().stream()
        .map(ManagedExecution::inspection)
        .map(BackendInspection::handle)
        .filter(item -> runId.equals(item.runId()) && item.generation() == generation)
        .findFirst()
        .orElseThrow(() -> ApiException.notFound("Execution"));
    terminate(handle);
  }

  @Override
  public void remove(BackendHandle handle) {
    try {
      docker.stopContainerCmd(handle.containerId()).withTimeout(15).exec();
    } catch (RuntimeException ignored) {
      // already stopped
    }
    try {
      docker.removeContainerCmd(handle.containerId()).withForce(true).exec();
    } catch (NotFoundException ignored) {
      // already removed
    }
    handle.networkName().ifPresent(this::removeNetwork);
    try {
      docker.removeVolumeCmd(handle.volumeName()).exec();
    } catch (NotFoundException ignored) {
      // already removed
    }
  }

  @Override
  public List<ManagedExecution> listManaged() {
    List<ManagedExecution> result = new ArrayList<>();
    docker.listContainersCmd().withShowAll(true)
        .withLabelFilter(List.of(MANAGER_LABEL + "=" + properties.getOrchestratorManagerId(), RUN_LABEL))
        .exec()
        .forEach(summary -> {
          String runId = summary.getLabels().get(RUN_LABEL);
          int generation = Integer.parseInt(summary.getLabels().getOrDefault(GENERATION_LABEL, "0"));
          String deadlineAt = summary.getLabels().get(DEADLINE_LABEL);
          if (runId == null || deadlineAt == null || generation < 1) {
            return;
          }
          Names names = names(runId, generation);
          String containerName = Optional.ofNullable(summary.getNames())
              .filter(values -> values.length > 0)
              .map(values -> values[0].replaceFirst("^/", ""))
              .orElse(names.containerName);
          BackendHandle handle = new BackendHandle(
              runId, generation, summary.getId(), containerName, names.volumeName,
              Optional.of(names.networkName), deadlineAt);
          result.add(new ManagedExecution(inspect(handle)));
        });
    return result;
  }

  @Override
  public int reapInfrastructureOrphans() {
    return 0;
  }

  @Override
  public boolean health() {
    try {
      docker.pingCmd().exec();
      return true;
    } catch (RuntimeException error) {
      return false;
    }
  }

  private void connect(String network, String container, List<String> aliases) {
    docker.connectToNetworkCmd()
        .withNetworkId(network)
        .withContainerId(container)
        .withContainerNetwork(new com.github.dockerjava.api.model.ContainerNetwork().withAliases(aliases))
        .exec();
  }

  private void removeNetwork(String name) {
    properties.getControlPlaneContainer().ifPresent(container -> {
      try {
        docker.disconnectFromNetworkCmd().withNetworkId(name).withContainerId(container).withForce(true).exec();
      } catch (RuntimeException ignored) {
        // already disconnected
      }
    });
    properties.getObjectStoreContainer().ifPresent(container -> {
      try {
        docker.disconnectFromNetworkCmd().withNetworkId(name).withContainerId(container).withForce(true).exec();
      } catch (RuntimeException ignored) {
        // already disconnected
      }
    });
    try {
      docker.removeNetworkCmd(name).exec();
    } catch (NotFoundException ignored) {
      // already removed
    }
  }

  private Map<String, String> labels(String runId, int generation, String deadlineAt) {
    Map<String, String> labels = new HashMap<>();
    labels.put(RUN_LABEL, runId);
    labels.put(GENERATION_LABEL, String.valueOf(generation));
    labels.put(DEADLINE_LABEL, deadlineAt);
    labels.put(MANAGER_LABEL, properties.getOrchestratorManagerId());
    return labels;
  }

  private static Map<String, String> with(Map<String, String> labels, String key, String value) {
    Map<String, String> copy = new HashMap<>(labels);
    copy.put(key, value);
    return copy;
  }

  private static Names names(String runId, int generation) {
    try {
      String digest = HexFormat.of().formatHex(
          MessageDigest.getInstance("SHA-256").digest((runId + ":" + generation).getBytes(StandardCharsets.UTF_8)))
          .substring(0, 16);
      return new Names("kross-run-" + digest, "kross-run-volume-" + digest, "kross-run-net-" + digest);
    } catch (Exception error) {
      throw new IllegalStateException(error);
    }
  }

  private static void assertSafe(RunLaunchRequest request) {
    Instant expiresAt = Instant.parse(request.tokenExpiresAt());
    Instant now = Instant.now();
    if (!expiresAt.isAfter(now) || expiresAt.isAfter(now.plus(Duration.ofMinutes(30)))) {
      throw new ApiException("INVALID_RUN_TOKEN_EXPIRY", "Run Token 必须在未来 30 分钟内过期", 400);
    }
  }

  private static Optional<String> normalize(String value) {
    if (value == null || value.startsWith("0001-")) {
      return Optional.empty();
    }
    try {
      return Optional.of(Instant.parse(value).toString());
    } catch (RuntimeException error) {
      return Optional.empty();
    }
  }

  private record Names(String containerName, String volumeName, String networkName) {}
}
