package com.kross.orchestrator;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.command.InspectContainerResponse;
import com.github.dockerjava.api.exception.NotFoundException;
import com.github.dockerjava.api.model.AccessMode;
import com.github.dockerjava.api.model.Bind;
import com.github.dockerjava.api.model.Capability;
import com.github.dockerjava.api.model.HostConfig;
import com.github.dockerjava.api.model.PropagationMode;
import com.github.dockerjava.api.model.RestartPolicy;
import com.github.dockerjava.api.model.SELContext;
import com.github.dockerjava.api.model.Volume;
import com.github.dockerjava.core.DefaultDockerClientConfig;
import com.github.dockerjava.core.DockerClientImpl;
import com.github.dockerjava.httpclient5.ApacheDockerHttpClient;
import com.kross.config.AppProperties;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "app.worker-runtime", havingValue = "local", matchIfMissing = true)
public class DockerContainerBackend implements ContainerBackend {
  static final String LABEL_PREFIX = "dev.kross.agent";
  static final String AGENT_LABEL = LABEL_PREFIX + ".id";
  static final String MANAGER_LABEL = LABEL_PREFIX + ".manager";
  static final String VOLUME_LABEL = LABEL_PREFIX + ".volume";

  private final DockerClient docker;
  private final AppProperties properties;

  public DockerContainerBackend(AppProperties properties) {
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
  public void ensureVolume(String agentId) {
    if (storage() == WorkerStorageMode.JUICEFS) {
      Path directory = WorkspacePaths.agentDirectory(properties, agentId);
      try {
        Files.createDirectories(directory);
      } catch (IOException error) {
        throw new IllegalStateException("Failed to create JuiceFS workspace " + directory, error);
      }
      return;
    }
    String volumeName = names(agentId).volumeName;
    try {
      docker.inspectVolumeCmd(volumeName).exec();
    } catch (NotFoundException ignored) {
      Map<String, String> labels = new HashMap<>();
      labels.put(AGENT_LABEL, agentId);
      labels.put(MANAGER_LABEL, properties.getOrchestratorManagerId());
      labels.put(VOLUME_LABEL, "true");
      docker.createVolumeCmd()
          .withName(volumeName)
          .withLabels(labels)
          .withDriver("local")
          .exec();
    }
  }

  @Override
  public BackendHandle start(StartRequest request) {
    ensureVolume(request.agentId());
    Names names = names(request.agentId());
    inspectContainer(names.containerName).ifPresent(existing ->
        docker.removeContainerCmd(existing.getId()).withForce(true).exec());
    Map<String, String> labels = new HashMap<>();
    labels.put(AGENT_LABEL, request.agentId());
    labels.put(MANAGER_LABEL, properties.getOrchestratorManagerId());
    HostConfig host = HostConfig.newHostConfig()
        .withBinds(workBind(request.agentId()))
        .withMemory(request.resourceLimits().memoryBytes())
        .withMemorySwap(request.resourceLimits().memoryBytes())
        .withNanoCPUs(request.resourceLimits().cpuMillis() * 1_000_000L)
        .withPidsLimit((long) request.resourceLimits().maxPids())
        .withCapDrop(Capability.ALL)
        .withCapAdd(Capability.CHOWN, Capability.SETUID, Capability.SETGID)
        .withSecurityOpts(List.of("no-new-privileges:true"))
        .withOomKillDisable(false)
        .withInit(true)
        .withAutoRemove(false)
        .withRestartPolicy(RestartPolicy.noRestart());
    properties.getAgentNetwork().ifPresent(host::withNetworkMode);
    String containerId = docker.createContainerCmd(properties.getWorkerImage())
        .withName(names.containerName)
        .withEnv(workerEnv(request))
        .withLabels(labels)
        .withWorkingDir("/work")
        .withStopTimeout(15)
        .withHostConfig(host)
        .exec()
        .getId();
    docker.startContainerCmd(containerId).exec();
    return new BackendHandle(request.agentId(), containerId, names.containerName, names.volumeName, "");
  }

  @Override
  public void stop(String agentId) {
    Names names = names(agentId);
    inspectContainer(names.containerName).ifPresent(state -> {
      if (Boolean.TRUE.equals(state.getState().getRunning())) {
        docker.stopContainerCmd(state.getId()).withTimeout(15).exec();
      }
    });
  }

  @Override
  public Optional<BackendInspection> inspect(String agentId) {
    Names names = names(agentId);
    return inspectContainer(names.containerName).map(state -> {
      boolean running = Boolean.TRUE.equals(state.getState().getRunning());
      String status = Optional.ofNullable(state.getState().getStatus()).orElse("");
      String mapped = running ? "running" : "created".equals(status) ? "created" : "exited";
      return new BackendInspection(
          new BackendHandle(agentId, state.getId(), names.containerName, names.volumeName, ""),
          mapped,
          running ? Optional.empty() : Optional.ofNullable(state.getState().getExitCode()));
    });
  }

  @Override
  public boolean health() {
    try {
      docker.pingCmd().exec();
      if (storage() == WorkerStorageMode.JUICEFS) {
        return Files.isDirectory(WorkspacePaths.requireMount(properties));
      }
      return true;
    } catch (RuntimeException error) {
      return false;
    }
  }

  private Bind workBind(String agentId) {
    Volume work = new Volume("/work");
    if (storage() == WorkerStorageMode.JUICEFS) {
      String hostPath = WorkspacePaths.agentDirectory(properties, agentId).toString();
      return new Bind(hostPath, work, AccessMode.rw, SELContext.none, false, PropagationMode.RSHARED);
    }
    return new Bind(names(agentId).volumeName, work);
  }

  private WorkerStorageMode storage() {
    return WorkerStorageMode.from(properties.getWorkerStorage());
  }

  private Optional<InspectContainerResponse> inspectContainer(String name) {
    try {
      return Optional.of(docker.inspectContainerCmd(name).exec());
    } catch (NotFoundException error) {
      return Optional.empty();
    }
  }

  private String[] workerEnv(StartRequest request) {
    List<String> env = new ArrayList<>();
    env.add("APP_AGENT_ID=" + request.agentId());
    env.add("APP_AGENT_TOKEN=" + request.agentToken());
    env.add("APP_CONTROL_PLANE_URL=" + request.controlPlaneUrl());
    env.add("APP_PHYSICAL_WORK_ROOT=/work");
    Optional.ofNullable(properties.getS3().getEndpoint())
        .map(String::trim)
        .filter(value -> !value.isBlank())
        .ifPresent(endpoint -> env.add("APP_S3_ENDPOINT=" + endpoint));
    return env.toArray(String[]::new);
  }

  private static Names names(String agentId) {
    return new Names(AgentNames.container(agentId), AgentNames.volume(agentId));
  }

  private record Names(String containerName, String volumeName) {}
}
