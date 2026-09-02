package com.kross.orchestrator;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kross.config.AppProperties;
import org.junit.jupiter.api.Test;

class WorkerStorageValidatorTest {
  @Test
  void rejectsRemovedClusterRuntime() {
    AppProperties properties = new AppProperties();
    properties.setWorkerRuntime("cluster");
    WorkerStorageValidator validator = new WorkerStorageValidator(properties);

    assertThatThrownBy(() -> validator.onApplicationEvent(null))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("kubernetes");
  }

  @Test
  void kubernetesRequiresJuicefsAndNamespace() {
    AppProperties properties = new AppProperties();
    properties.setWorkerRuntime("kubernetes");
    properties.setWorkerStorage("local");
    WorkerStorageValidator validator = new WorkerStorageValidator(properties);

    assertThatThrownBy(() -> validator.onApplicationEvent(null))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("juicefs");

    properties.setWorkerStorage("juicefs");
    assertThatThrownBy(() -> validator.onApplicationEvent(null))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("APP_KUBERNETES_NAMESPACE");
  }
}
