package com.kross.fleet;

import java.util.concurrent.atomic.AtomicBoolean;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = "kross.worker-runtime", havingValue = "cluster")
public class NodeScheduler {
  private final NodeHub hub;
  private final AtomicBoolean running = new AtomicBoolean(false);

  @Scheduled(fixedDelayString = "${kross.scheduler.poll-ms:5000}")
  public void tick() {
    if (!running.compareAndSet(false, true)) {
      return;
    }
    try {
      hub.markStaleOffline();
    } finally {
      running.set(false);
    }
  }
}
