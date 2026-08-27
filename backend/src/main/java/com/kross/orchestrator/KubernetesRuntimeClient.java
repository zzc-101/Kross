package com.kross.orchestrator;

import io.fabric8.kubernetes.api.model.Node;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.Pod;
import java.util.List;
import java.util.Optional;

public interface KubernetesRuntimeClient {
  Optional<Pod> getPod(String namespace, String name);

  Pod createPod(Pod pod);

  void deletePod(String namespace, String name);

  Optional<PersistentVolumeClaim> getPvc(String namespace, String name);

  PersistentVolumeClaim createPvc(PersistentVolumeClaim claim);

  List<Pod> listAgentPods(String namespace);

  List<Node> listNodes();

  boolean ping(String namespace);
}
