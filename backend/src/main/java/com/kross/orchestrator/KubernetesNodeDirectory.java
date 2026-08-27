package com.kross.orchestrator;

import com.kross.config.KrossProperties;
import com.kross.identity.dto.NodeHealthView;
import io.fabric8.kubernetes.api.model.Node;
import io.fabric8.kubernetes.api.model.NodeCondition;
import java.time.DateTimeException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = "kross.worker-runtime", havingValue = "kubernetes")
public class KubernetesNodeDirectory {
  private final KrossProperties properties;
  private final KubernetesRuntimeClient runtime;

  public List<NodeHealthView> listHealth() {
    try {
      String namespace = properties.getKubernetes().requireNamespace();
      Map<String, Long> running = runtime.listAgentPods(namespace).stream()
          .filter(KubernetesContainerBackend::isUsable)
          .map(pod -> Optional.ofNullable(pod.getSpec()).map(spec -> spec.getNodeName()).orElse(""))
          .filter(node -> !node.isBlank())
          .collect(Collectors.groupingBy(node -> node, Collectors.counting()));
      return runtime.listNodes().stream()
          .filter(KubernetesNodeDirectory::isReady)
          .map(node -> toView(node, running))
          .toList();
    } catch (RuntimeException error) {
      log.warn("Failed to list Kubernetes nodes for the dashboard: {}", error.getMessage());
      return List.of();
    }
  }

  private static NodeHealthView toView(Node node, Map<String, Long> running) {
    String name = Optional.ofNullable(node.getMetadata()).map(meta -> meta.getName()).orElse("");
    int count = Optional.ofNullable(running.get(name)).map(Long::intValue).orElse(0);
    Instant seen = Optional.ofNullable(node.getStatus())
        .map(status -> status.getConditions())
        .orElse(List.of())
        .stream()
        .filter(condition -> "Ready".equals(condition.getType()))
        .map(NodeCondition::getLastHeartbeatTime)
        .filter(Objects::nonNull)
        .map(time -> {
          try {
            return Instant.parse(time);
          } catch (DateTimeException ignored) {
            return null;
          }
        })
        .findFirst()
        .orElse(null);
    return new NodeHealthView(name, name, "online", count, true, seen, true);
  }

  private static boolean isReady(Node node) {
    return Optional.ofNullable(node.getStatus())
        .map(status -> status.getConditions())
        .orElse(List.of())
        .stream()
        .anyMatch(condition -> "Ready".equals(condition.getType()) && "True".equals(condition.getStatus()));
  }
}
