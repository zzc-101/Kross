package com.kross.orchestrator;

import com.kross.api.ApiException;
import com.kross.config.AppProperties;
import io.fabric8.kubernetes.api.model.ContainerBuilder;
import io.fabric8.kubernetes.api.model.EnvVar;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaimBuilder;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PodBuilder;
import io.fabric8.kubernetes.api.model.Quantity;
import io.fabric8.kubernetes.api.model.ResourceRequirementsBuilder;
import io.fabric8.kubernetes.api.model.SecurityContextBuilder;
import io.fabric8.kubernetes.api.model.VolumeBuilder;
import io.fabric8.kubernetes.api.model.VolumeMountBuilder;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = "app.worker-runtime", havingValue = "kubernetes")
public class KubernetesContainerBackend implements ContainerBackend {
  private final AppProperties properties;
  private final KubernetesRuntimeClient runtime;

  @Override
  public void ensureVolume(String agentId) {
    String namespace = namespace();
    String pvcName = KubernetesAgentNames.pvc(agentId);
    if (runtime.getPvc(namespace, pvcName).isPresent()) {
      return;
    }
    AppProperties.Kubernetes kubernetes = properties.getKubernetes();
    PersistentVolumeClaim claim = new PersistentVolumeClaimBuilder()
        .withNewMetadata()
        .withName(pvcName)
        .withNamespace(namespace)
        .withLabels(agentLabels(agentId))
        .withAnnotations(Map.of(
            KubernetesAgentNames.AGENT_ID_ANNOTATION, agentId,
            KubernetesAgentNames.WORKSPACE_PATH_ANNOTATION, KubernetesAgentNames.workspacePath(agentId)))
        .endMetadata()
        .withNewSpec()
        .withAccessModes("ReadWriteMany")
        .withStorageClassName(kubernetes.getStorageClass())
        .withNewResources()
        .withRequests(Map.of("storage", new Quantity(kubernetes.getWorkspaceSize())))
        .endResources()
        .endSpec()
        .build();
    runtime.createPvc(claim);
  }

  @Override
  public BackendHandle start(StartRequest request) {
    String agentId = request.agentId();
    String namespace = namespace();
    String podName = KubernetesAgentNames.pod(agentId);
    Optional<Pod> existing = runtime.getPod(namespace, podName);
    if (existing.filter(KubernetesContainerBackend::isUsable).isPresent()) {
      return handle(agentId, existing.get());
    }
    ensureVolume(agentId);
    if (existing.isPresent()) {
      fence(namespace, podName);
    }
    Pod created = runtime.createPod(buildPod(request));
    return handle(agentId, created);
  }

  @Override
  public void stop(String agentId) {
    String namespace = namespace();
    String podName = KubernetesAgentNames.pod(agentId);
    if (runtime.getPod(namespace, podName).isEmpty()) {
      return;
    }
    fence(namespace, podName);
  }

  @Override
  public Optional<BackendInspection> inspect(String agentId) {
    return runtime.getPod(namespace(), KubernetesAgentNames.pod(agentId)).map(pod -> {
      boolean running = isUsable(pod);
      Integer exit = Optional.ofNullable(pod.getStatus())
          .map(status -> status.getContainerStatuses())
          .filter(statuses -> !statuses.isEmpty())
          .flatMap(statuses -> Optional.ofNullable(statuses.getFirst().getState()))
          .flatMap(state -> Optional.ofNullable(state.getTerminated()))
          .map(terminated -> terminated.getExitCode())
          .orElse(null);
      return new BackendInspection(
          handle(agentId, pod),
          running ? "running" : Optional.ofNullable(pod.getStatus()).map(status -> status.getPhase()).orElse("unknown")
              .toLowerCase(),
          running ? Optional.empty() : Optional.ofNullable(exit));
    });
  }

  @Override
  public boolean health() {
    try {
      return runtime.ping(namespace());
    } catch (RuntimeException error) {
      log.warn("Kubernetes API health check failed: {}", error.getMessage());
      return false;
    }
  }

  private Pod buildPod(StartRequest request) {
    String agentId = request.agentId();
    String namespace = namespace();
    ResourceLimits limits = request.resourceLimits();
    var container = new ContainerBuilder()
        .withName("worker")
        .withImage(properties.getWorkerImage())
        .withImagePullPolicy("IfNotPresent")
        .withEnv(workerEnv(request))
        .withResources(new ResourceRequirementsBuilder()
            .withLimits(Map.of(
                "cpu", new Quantity(limits.cpuMillis() + "m"),
                "memory", new Quantity(String.valueOf(limits.memoryBytes()))))
            .withRequests(Map.of(
                "cpu", new Quantity(limits.cpuMillis() + "m"),
                "memory", new Quantity(String.valueOf(limits.memoryBytes()))))
            .build())
        .withSecurityContext(new SecurityContextBuilder()
            .withAllowPrivilegeEscalation(false)
            .withNewCapabilities()
            .addToDrop("ALL")
            .addToAdd("CHOWN", "SETUID", "SETGID")
            .endCapabilities()
            .build())
        .withVolumeMounts(new VolumeMountBuilder().withName("work").withMountPath("/work").build())
        .withWorkingDir("/work")
        .build();
    var spec = new PodBuilder()
        .withNewMetadata()
        .withName(KubernetesAgentNames.pod(agentId))
        .withNamespace(namespace)
        .withLabels(agentLabels(agentId))
        .withAnnotations(Map.of(
            KubernetesAgentNames.AGENT_ID_ANNOTATION, agentId,
            KubernetesAgentNames.WORKSPACE_PATH_ANNOTATION, KubernetesAgentNames.workspacePath(agentId)))
        .endMetadata()
        .withNewSpec()
        .withRestartPolicy("Never")
        .withAutomountServiceAccountToken(false)
        .withContainers(List.of(container))
        .withVolumes(new VolumeBuilder()
            .withName("work")
            .withNewPersistentVolumeClaim()
            .withClaimName(KubernetesAgentNames.pvc(agentId))
            .endPersistentVolumeClaim()
            .build())
        .endSpec()
        .build();
    request.preferredNodeId().ifPresent(node -> spec.getSpec().setAffinity(
        new io.fabric8.kubernetes.api.model.AffinityBuilder()
            .withNewNodeAffinity()
            .addNewPreferredDuringSchedulingIgnoredDuringExecution()
            .withWeight(80)
            .withNewPreference()
            .addNewMatchExpression()
            .withKey("kubernetes.io/hostname")
            .withOperator("In")
            .withValues(node)
            .endMatchExpression()
            .endPreference()
            .endPreferredDuringSchedulingIgnoredDuringExecution()
            .endNodeAffinity()
            .build()));
    return spec;
  }

  private void fence(String namespace, String podName) {
    runtime.deletePod(namespace, podName);
    Duration timeout = Duration.ofMillis(properties.getAgent().getStartTimeoutMs());
    Instant deadline = Instant.now().plus(timeout);
    while (runtime.getPod(namespace, podName).isPresent()) {
      if (!Instant.now().isBefore(deadline)) {
        throw new ApiException(
            "agent_pod_fence_timeout",
            "Timed out waiting for the previous worker pod to terminate",
            503);
      }
      try {
        Thread.sleep(50L);
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new ApiException("agent_pod_fence_timeout", "Interrupted while fencing the worker pod", 503);
      }
    }
  }

  private BackendHandle handle(String agentId, Pod pod) {
    String uid = Optional.ofNullable(pod.getMetadata().getUid()).orElse("");
    String node = Optional.ofNullable(pod.getSpec()).map(spec -> spec.getNodeName()).orElse("");
    return new BackendHandle(
        agentId,
        uid,
        KubernetesAgentNames.pod(agentId),
        KubernetesAgentNames.pvc(agentId),
        Optional.ofNullable(node).orElse(""));
  }

  private Map<String, String> agentLabels(String agentId) {
    return Map.of(
        KubernetesAgentNames.AGENT_LABEL, agentId,
        KubernetesAgentNames.MANAGER_LABEL, properties.getOrchestratorManagerId());
  }

  private String namespace() {
    return properties.getKubernetes().requireNamespace();
  }

  private List<EnvVar> workerEnv(StartRequest request) {
    List<EnvVar> env = new ArrayList<>();
    env.add(new EnvVar("APP_AGENT_ID", request.agentId(), null));
    env.add(new EnvVar("APP_AGENT_TOKEN", request.agentToken(), null));
    env.add(new EnvVar("APP_CONTROL_PLANE_URL", request.controlPlaneUrl(), null));
    env.add(new EnvVar("APP_PHYSICAL_WORK_ROOT", "/work", null));
    env.add(new io.fabric8.kubernetes.api.model.EnvVarBuilder()
        .withName("APP_NODE_ID")
        .withNewValueFrom()
        .withNewFieldRef()
        .withFieldPath("spec.nodeName")
        .endFieldRef()
        .endValueFrom()
        .build());
    Optional.ofNullable(properties.getS3().getEndpoint())
        .map(String::trim)
        .filter(value -> !value.isBlank())
        .ifPresent(endpoint -> env.add(new EnvVar("APP_S3_ENDPOINT", endpoint, null)));
    return env;
  }

  static boolean isUsable(Pod pod) {
    if (pod == null || pod.getMetadata() == null || pod.getMetadata().getDeletionTimestamp() != null) {
      return false;
    }
    return Optional.ofNullable(pod.getStatus())
        .map(status -> status.getPhase())
        .filter(phase -> "Running".equals(phase))
        .isPresent();
  }
}
