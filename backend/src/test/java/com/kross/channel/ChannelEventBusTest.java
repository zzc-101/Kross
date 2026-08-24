package com.kross.channel;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class ChannelEventBusTest {
  @Test
  void usesFiniteSubscriberLifetime() {
    ChannelEventBus events = new ChannelEventBus();

    assertThat(events.subscribe("conversation-1").getTimeout()).isEqualTo(300_000L);
  }
}
