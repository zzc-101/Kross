package com.kross.orchestrator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kross.api.ApiException;
import com.kross.config.KrossProperties;
import io.fabric8.kubernetes.api.model.Node;
import io.fabric8.kubernetes.api.model.ObjectMeta;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PodSpec;
import io.fabric8.kubernetes.api.model.PodStatus;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class KubernetesContainerBackendTest {
  private KrossProperties properties;
  private FakeKubernetesRuntimeClient runtime;
  private KubernetesContainerBackend backend;

  @BeforeEach
  void setUp() {
    properties = new KrossProperties();
    properties.setWorkerRuntime("kubernetes");
    properties.setWorkerStorage("juicefs");
    properties.setWorkerImage("kross-worker:local");
    properties.getKubernetes().setNamespace("kross");
    properties.getAgent().setStartTimeoutMs(200);
    runtime = new FakeKubernetesRuntimeClient();
    backend = new KubernetesContainerBackend(properties, runtime);
  }

  @Test
  void startReturnsExistingRunningPodWithoutRecreate() {
    Pod existing = runningPod("agent-1", "uid-existing", "node-a");
    runtime.pods.put(KubernetesAgentNames.pod("agent-1"), existing);

    ContainerBackend.BackendHandle handle = backend.start(request("agent-1"));

    assertThat(handle.containerId()).isEqualTo("uid-existing");
    assertThat(handle.nodeId()).isEqualTo("node-a");
    assertThat(runtime.createdPods).isEmpty();
  }

  @Test
  void startWaitsForTerminatingPodThenCreates() {
    Pod terminating = runningPod("agent-1", "uid-old", "node-a");
    terminating.getMetadata().setDeletionTimestamp("2026-08-27T00:00:00Z");
    runtime.pods.put(KubernetesAgentNames.pod("agent-1"), terminating);

    ContainerBackend.BackendHandle handle = backend.start(request("agent-1"));

    assertThat(handle.containerId()).isNotBlank();
    assertThat(handle.containerId()).isNotEqualTo("uid-old");
    assertThat(runtime.createdPods).hasSize(1);
    assertThat(runtime.getPvc("kross", KubernetesAgentNames.pvc("agent-1"))).isPresent();
  }

  @Test
  void startFailsWhenFenceTimesOut() {
    runtime.stickyPods = true;
    Pod terminating = runningPod("agent-1", "uid-old", "node-a");
    terminating.getMetadata().setDeletionTimestamp("2026-08-27T00:00:00Z");
    runtime.pods.put(KubernetesAgentNames.pod("agent-1"), terminating);

    assertThatThrownBy(() -> backend.start(request("agent-1")))
        .isInstanceOf(ApiException.class)
        .extracting(error -> ((ApiException) error).getCode())
        .isEqualTo("agent_pod_fence_timeout");
    assertThat(runtime.createdPods).isEmpty();
  }

  @Test
  void stopDeletesPodButKeepsPvc() {
    runtime.pods.put(KubernetesAgentNames.pod("agent-1"), runningPod("agent-1", "uid-1", "node-a"));
    backend.ensureVolume("agent-1");

    backend.stop("agent-1");

    assertThat(runtime.getPod("kross", KubernetesAgentNames.pod("agent-1"))).isEmpty();
    assertThat(runtime.getPvc("kross", KubernetesAgentNames.pvc("agent-1"))).isPresent();
  }

  @Test
  void inspectMapsNodeName() {
    runtime.pods.put(KubernetesAgentNames.pod("agent-1"), runningPod("agent-1", "uid-1", "worker-2"));

    Optional<ContainerBackend.BackendInspection> inspection = backend.inspect("agent-1");

    assertThat(inspection).isPresent();
    assertThat(inspection.get().state()).isEqualTo("running");
    assertThat(inspection.get().handle().nodeId()).isEqualTo("worker-2");
    assertThat(inspection.get().handle().containerId()).isEqualTo("uid-1");
  }

  @Test
  void preferredNodeIsCopiedOntoNewPod() {
    backend.start(new ContainerBackend.StartRequest(
        "agent-1",
        "token",
        "http://kross-server:8787",
        new ContainerBackend.ResourceLimits(1000, 1024, 64),
        Optional.of("node-hot")));

    assertThat(runtime.createdPods).hasSize(1);
    assertThat(runtime.createdPods.getFirst().getSpec().getAffinity().getNodeAffinity()
        .getPreferredDuringSchedulingIgnoredDuringExecution())
        .isNotEmpty();
  }

  private static ContainerBackend.StartRequest request(String agentId) {
    return new ContainerBackend.StartRequest(
        agentId,
        "token",
        "http://kross-server:8787",
        new ContainerBackend.ResourceLimits(1000, 1024, 64));
  }

  private static Pod runningPod(String agentId, String uid, String node) {
    ObjectMeta meta = new ObjectMeta();
    meta.setName(KubernetesAgentNames.pod(agentId));
    meta.setNamespace("kross");
    meta.setUid(uid);
    PodSpec spec = new PodSpec();
    spec.setNodeName(node);
    PodStatus status = new PodStatus();
    status.setPhase("Running");
    Pod pod = new Pod();
    pod.setMetadata(meta);
    pod.setSpec(spec);
    pod.setStatus(status);
    return pod;
  }

  private static final class FakeKubernetesRuntimeClient implements KubernetesRuntimeClient {
    private final Map<String, Pod> pods = new LinkedHashMap<>();
    private final Map<String, PersistentVolumeClaim> pvcs = new LinkedHashMap<>();
    private final List<Pod> createdPods = new ArrayList<>();
    private boolean stickyPods;

    @Override
    public Optional<Pod> getPod(String namespace, String name) {
      return Optional.ofNullable(pods.get(name));
    }

    @Override
    public Pod createPod(Pod pod) {
      if (pod.getMetadata().getUid() == null) {
        pod.getMetadata().setUid(UUID.randomUUID().toString());
      }
      if (pod.getStatus() == null) {
        pod.setStatus(new PodStatus());
      }
      pod.getStatus().setPhase("Running");
      if (pod.getSpec() != null && pod.getSpec().getNodeName() == null) {
        pod.getSpec().setNodeName("node-1");
      }
      createdPods.add(pod);
      pods.put(pod.getMetadata().getName(), pod);
      return pod;
    }

    @Override
    public void deletePod(String namespace, String name) {
      if (!stickyPods) {
        pods.remove(name);
      }
    }

    @Override
    public Optional<PersistentVolumeClaim> getPvc(String namespace, String name) {
      return Optional.ofNullable(pvcs.get(name));
    }

    @Override
    public PersistentVolumeClaim createPvc(PersistentVolumeClaim claim) {
      pvcs.put(claim.getMetadata().getName(), claim);
      return claim;
    }

    @Override
    public List<Pod> listAgentPods(String namespace) {
      return List.copyOf(pods.values());
    }

    @Override
    public List<Node> listNodes() {
      return List.of();
    }

    @Override
    public boolean ping(String namespace) {
      return true;
    }
  }
}
