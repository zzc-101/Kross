package com.kross.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.kross.channel.AgentSocketHub;
import com.kross.channel.WorkerOfferBus;
import com.kross.config.AppProperties;
import com.kross.identity.OrganizationAccess;
import com.kross.orchestrator.ContainerBackend;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class AgentLeaseServiceTest {
  private AgentMapper mapper;
  private WorkerOfferBus offers;
  private AgentLeaseService service;

  @BeforeEach
  void setUp() {
    mapper = mock(AgentMapper.class);
    offers = mock(WorkerOfferBus.class);
    AppProperties properties = new AppProperties();
    service = new AgentLeaseService(
        mapper,
        mock(OrganizationAccess.class),
        mock(ContainerBackend.class),
        properties,
        mock(AgentSocketHub.class),
        offers,
        mock(AgentMemoryService.class),
        mock(AgentRuntimeOps.class),
        new AgentTransactions());
  }

  @Test
  void recoverExpiredJobLeasesOffersRecoveredAgents() {
    when(mapper.recoverExpiredLeases(any(Instant.class), anyInt())).thenReturn(List.of("agent-1", "agent-2"));

    service.recoverExpiredJobLeases();

    verify(offers).offer("agent-1");
    verify(offers).offer("agent-2");
  }

  @Test
  void recoverExpiredJobLeasesDoesNothingWhenNothingExpired() {
    when(mapper.recoverExpiredLeases(any(Instant.class), anyInt())).thenReturn(List.of());

    service.recoverExpiredJobLeases();

    verify(offers, never()).offer(any());
  }

  @Test
  void releaseClaimedJobIsIdempotentWhenLeaseIsAlreadyGone() {
    when(mapper.releaseLeasedMessage("agent-1", "message-1", "lease-1")).thenReturn(0);

    service.releaseClaimedJob("agent-1", "message-1", "lease-1");
    service.releaseClaimedJob("agent-1", "message-1", "lease-1");

    verify(mapper, org.mockito.Mockito.times(2))
        .releaseLeasedMessage("agent-1", "message-1", "lease-1");
    verify(offers, never()).offer(any());
  }

  @Test
  void releaseClaimedJobOffersOnceWhenLeaseIsReleased() {
    when(mapper.releaseLeasedMessage("agent-1", "message-1", "lease-1")).thenReturn(1);

    service.releaseClaimedJob("agent-1", "message-1", "lease-1");

    verify(offers).offer("agent-1");
  }

  @Test
  void concurrentReleaseOfTheSameLeaseOffersAtMostOnce() throws Exception {
    AtomicInteger remaining = new AtomicInteger(1);
    when(mapper.releaseLeasedMessage(eq("agent-1"), eq("message-1"), eq("lease-1")))
        .thenAnswer(invocation -> remaining.getAndSet(0) == 1 ? 1 : 0);
    CountDownLatch start = new CountDownLatch(1);
    CountDownLatch done = new CountDownLatch(2);

    Thread first = Thread.ofVirtual().start(() -> {
      await(start);
      service.releaseClaimedJob("agent-1", "message-1", "lease-1");
      done.countDown();
    });
    Thread second = Thread.ofVirtual().start(() -> {
      await(start);
      service.releaseClaimedJob("agent-1", "message-1", "lease-1");
      done.countDown();
    });
    start.countDown();
    assertThat(done.await(2, TimeUnit.SECONDS)).isTrue();
    first.join();
    second.join();

    verify(offers).offer("agent-1");
  }

  private static void await(CountDownLatch latch) {
    try {
      latch.await(2, TimeUnit.SECONDS);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }
}
