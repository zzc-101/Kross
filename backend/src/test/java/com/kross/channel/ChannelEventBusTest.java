package com.kross.channel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ChannelEventBusTest {
  @Test
  void usesFiniteSubscriberLifetime() {
    ChannelEventBus events = new ChannelEventBus();

    assertThat(events.subscribe("conversation-1").getTimeout()).isEqualTo(300_000L);
  }

  @Test
  void publishFansOutLocallyAndToCluster() {
    ClusterFanout fanout = mock(ClusterFanout.class);
    ChannelEventBus events = new ChannelEventBus(new ObjectMapper().findAndRegisterModules(), fanout);
    ChannelEvent event = ChannelEvent.of("text-delta", "conversation-1", "message-1", Map.of("text", "hi"));

    events.publish(event);

    verify(fanout).publish(ClusterFanout.CHANNEL_EVENTS, event);
  }

  @Test
  void publishDoesNotRequireClusterFanout() {
    ChannelEventBus events = new ChannelEventBus();

    events.publish(ChannelEvent.of("text-delta", "conversation-1", "message-1", Map.of()));
  }
}
