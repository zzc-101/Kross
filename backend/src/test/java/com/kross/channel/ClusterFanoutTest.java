package com.kross.channel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

class ClusterFanoutTest {
  @Test
  void dispatchSkipsMessagesFromThisInstance() {
    ClusterFanout fanout = new ClusterFanout(
        new ObjectMapper().findAndRegisterModules(),
        provider(null),
        provider(null));
    AtomicInteger hits = new AtomicInteger();
    fanout.on(ClusterFanout.CHANNEL_EVENTS, body -> hits.incrementAndGet());
    ClusterFanout.Envelope self = new ClusterFanout.Envelope(
        fanout.instanceId(), new ObjectMapper().createObjectNode().put("type", "text-delta"));

    fanout.dispatch(ClusterFanout.CHANNEL_EVENTS, write(self));

    assertThat(hits.get()).isZero();
  }

  @Test
  void dispatchDeliversRemoteMessages() {
    ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();
    ClusterFanout fanout = new ClusterFanout(mapper, provider(null), provider(null));
    AtomicReference<String> seen = new AtomicReference<>();
    fanout.on(ClusterFanout.WORKER_OFFER, body -> seen.set(body.path("agentId").asText()));
    ClusterFanout.Envelope remote = new ClusterFanout.Envelope(
        "other-instance", mapper.valueToTree(Map.of("agentId", "agent-1")));

    fanout.dispatch(ClusterFanout.WORKER_OFFER, write(remote));

    assertThat(seen.get()).isEqualTo("agent-1");
  }

  @Test
  void publishSwallowsRedisFailures() {
    ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();
    StringRedisTemplate redis = mock(StringRedisTemplate.class);
    doThrow(new RedisConnectionFailureException("down"))
        .when(redis).convertAndSend(eq(ClusterFanout.CHANNEL_EVENTS), any());
    ClusterFanout fanout = new ClusterFanout(mapper, provider(null), provider(redis));

    fanout.publish(ClusterFanout.CHANNEL_EVENTS, new ChannelEvent("text-delta", "conv-1", "msg-1", Map.of()));

    verify(redis).convertAndSend(eq(ClusterFanout.CHANNEL_EVENTS), any());
    assertThat(fanout.isDegraded()).isTrue();
  }

  private static String write(ClusterFanout.Envelope envelope) {
    try {
      return new ObjectMapper().findAndRegisterModules().writeValueAsString(envelope);
    } catch (Exception error) {
      throw new IllegalStateException(error);
    }
  }

  @SuppressWarnings("unchecked")
  private static <T> ObjectProvider<T> provider(T value) {
    ObjectProvider<T> provider = mock(ObjectProvider.class);
    when(provider.getIfAvailable()).thenReturn(value);
    return provider;
  }
}
