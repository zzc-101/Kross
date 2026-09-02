package com.kross.connector.feishu;

import com.kross.connector.ConnectorGateway;
import com.kross.connector.entity.ConnectorInbox;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
public class ConnectorInboxProcessor {
  private final ConnectorGateway gateway;
  private final FeishuAdapter feishu;
  private final AtomicBoolean running = new AtomicBoolean(false);

  public void process(String id) {
    Optional<ConnectorInbox> claimed = gateway.beginInbox(id);
    if (claimed.isEmpty()) {
      return;
    }
    run(claimed.get());
  }

  @Scheduled(fixedDelay = 5_000)
  public void retry() {
    if (!running.compareAndSet(false, true)) {
      return;
    }
    try {
      gateway.claimInbox().ifPresent(this::run);
    } catch (Exception error) {
      log.warn("Connector inbox retry failed: {}", error.getMessage());
    } finally {
      running.set(false);
    }
  }

  private void run(ConnectorInbox row) {
    try {
      if (ConnectorGateway.FEISHU.equals(row.getChannel())) {
        feishu.handlePayload(row.getPayload());
      }
      gateway.markInboxDone(row.getId());
    } catch (Exception error) {
      log.warn("Connector inbox {} failed: {}", row.getId(), error.getMessage());
      gateway.markInboxFailed(row.getId(), error.getMessage());
    }
  }
}
