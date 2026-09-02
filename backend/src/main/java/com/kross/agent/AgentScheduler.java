package com.kross.agent;

import java.util.concurrent.atomic.AtomicBoolean;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
public class AgentScheduler {
  private final AgentLeaseService agents;
  private final AtomicBoolean running = new AtomicBoolean(false);

  @Scheduled(fixedDelayString = "${app.scheduler.poll-ms:5000}")
  public void tick() {
    if (!running.compareAndSet(false, true)) {
      return;
    }
    try {
      agents.recoverExpiredJobLeases();
      agents.reconcileRuntimeAgents();
      agents.sleepIdleAgents();
    } catch (RuntimeException error) {
      log.warn("Agent idle scheduler failed: {}", error.getMessage());
    } finally {
      running.set(false);
    }
  }

  @Scheduled(fixedDelay = 60 * 60 * 1000L)
  public void cleanupDeliveryReceipts() {
    agents.cleanupDeliveryReceipts();
  }
}
