package com.kross.orchestrator;

import io.fabric8.kubernetes.api.model.Node;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.client.KubernetesClient;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = "app.worker-runtime", havingValue = "kubernetes")
public class Fabric8KubernetesRuntimeClient implements KubernetesRuntimeClient {
  private final KubernetesClient client;

  @Override
  public Optional<Pod> getPod(String namespace, String name) {
    return Optional.ofNullable(client.pods().inNamespace(namespace).withName(name).get());
  }

  @Override
  public Pod createPod(Pod pod) {
    return client.pods().inNamespace(pod.getMetadata().getNamespace()).resource(pod).create();
  }

  @Override
  public void deletePod(String namespace, String name) {
    client.pods().inNamespace(namespace).withName(name).delete();
  }

  @Override
  public Optional<PersistentVolumeClaim> getPvc(String namespace, String name) {
    return Optional.ofNullable(client.persistentVolumeClaims().inNamespace(namespace).withName(name).get());
  }

  @Override
  public PersistentVolumeClaim createPvc(PersistentVolumeClaim claim) {
    return client.persistentVolumeClaims().inNamespace(claim.getMetadata().getNamespace()).resource(claim).create();
  }

  @Override
  public List<Pod> listAgentPods(String namespace) {
    return client.pods().inNamespace(namespace).withLabel(KubernetesAgentNames.AGENT_LABEL).list().getItems();
  }

  @Override
  public List<Node> listNodes() {
    return client.nodes().list().getItems();
  }

  @Override
  public boolean ping(String namespace) {
    client.pods().inNamespace(namespace).list();
    return true;
  }
}
