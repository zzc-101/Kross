package com.kross.orchestrator;

import com.kross.config.KrossProperties;
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
    if ("cluster".equalsIgnoreCase(properties.getWorkerRuntime())) {
      if (WorkerStorageMode.from(properties.getWorkerStorage()) != WorkerStorageMode.JUICEFS) {
        throw new IllegalStateException("KROSS_WORKER_RUNTIME=cluster requires KROSS_WORKER_STORAGE=juicefs");
      }
      if (Optional.ofNullable(properties.getNodeToken()).filter(value -> !value.isBlank()).isEmpty()) {
        throw new IllegalStateException("KROSS_WORKER_RUNTIME=cluster requires KROSS_NODE_TOKEN");
      }
      return;
    }
    WorkerStorageMode.from(properties.getWorkerStorage()).validate(properties);
  }
}
