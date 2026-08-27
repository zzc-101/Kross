package com.kross.orchestrator;

import com.kross.config.KrossProperties;
import java.util.Locale;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class WorkerStorageValidator implements ApplicationListener<ApplicationReadyEvent> {
  private final KrossProperties properties;

  @Override
  public void onApplicationEvent(ApplicationReadyEvent event) {
    String runtime = Optional.ofNullable(properties.getWorkerRuntime()).orElse("local").toLowerCase(Locale.ROOT);
    if ("cluster".equals(runtime)) {
      throw new IllegalStateException(
          "KROSS_WORKER_RUNTIME=cluster has been removed; use kubernetes with a k3s Helm install");
    }
    if ("kubernetes".equals(runtime)) {
      if (WorkerStorageMode.from(properties.getWorkerStorage()) != WorkerStorageMode.JUICEFS) {
        throw new IllegalStateException("KROSS_WORKER_RUNTIME=kubernetes requires KROSS_WORKER_STORAGE=juicefs");
      }
      properties.getKubernetes().requireNamespace();
      return;
    }
    if (!"local".equals(runtime)) {
      throw new IllegalStateException(
          "Unknown KROSS_WORKER_RUNTIME=" + properties.getWorkerRuntime() + "; expected local or kubernetes");
    }
    WorkerStorageMode.from(properties.getWorkerStorage()).validate(properties);
  }
}
