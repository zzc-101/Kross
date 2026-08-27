package com.kross.orchestrator;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kross.config.KrossProperties;
import org.junit.jupiter.api.Test;

class WorkerStorageValidatorTest {
  @Test
  void rejectsRemovedClusterRuntime() {
    KrossProperties properties = new KrossProperties();
    properties.setWorkerRuntime("cluster");
    WorkerStorageValidator validator = new WorkerStorageValidator(properties);

    assertThatThrownBy(() -> validator.onApplicationEvent(null))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("kubernetes");
  }

  @Test
  void kubernetesRequiresJuicefsAndNamespace() {
    KrossProperties properties = new KrossProperties();
    properties.setWorkerRuntime("kubernetes");
    properties.setWorkerStorage("local");
    WorkerStorageValidator validator = new WorkerStorageValidator(properties);

    assertThatThrownBy(() -> validator.onApplicationEvent(null))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("juicefs");

    properties.setWorkerStorage("juicefs");
    assertThatThrownBy(() -> validator.onApplicationEvent(null))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("KROSS_KUBERNETES_NAMESPACE");
  }
}
