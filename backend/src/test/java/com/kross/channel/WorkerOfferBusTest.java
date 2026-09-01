package com.kross.channel;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

class WorkerOfferBusTest {
  @Test
  void offerDeliversLocallyAndPublishes() {
    AgentSocketHub sockets = mock(AgentSocketHub.class);
    ClusterFanout fanout = mock(ClusterFanout.class);
    ObjectProvider<ClusterFanout> provider = mock(ObjectProvider.class);
    when(provider.getIfAvailable()).thenReturn(fanout);
    WorkerOfferBus bus = new WorkerOfferBus(sockets, provider);

    bus.offer("agent-1");

    verify(sockets).offerJob("agent-1");
    verify(fanout).publish(ClusterFanout.WORKER_OFFER, Map.of("agentId", "agent-1"));
  }

  @Test
  void offerStillWorksWhenRedisIsAbsent() {
    AgentSocketHub sockets = mock(AgentSocketHub.class);
    ObjectProvider<ClusterFanout> provider = mock(ObjectProvider.class);
    when(provider.getIfAvailable()).thenReturn(null);
    WorkerOfferBus bus = new WorkerOfferBus(sockets, provider);

    bus.offer("agent-1");

    verify(sockets).offerJob("agent-1");
  }
}
