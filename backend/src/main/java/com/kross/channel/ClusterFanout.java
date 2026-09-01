package com.kross.channel;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.stereotype.Component;

/**
 * Lossy Redis Pub/Sub fan-out for control-plane events. Messages may be
 * dropped; subscribers reconnect and persist the final snapshot. Redis
 * outages degrade to a no-op publish so a single replica keeps working
 * with its in-process path, matching {@link com.kross.cache.FaultTolerantCacheManager}.
 */
@Slf4j
@Component
public class ClusterFanout implements InitializingBean, DisposableBean {
  public static final String CHANNEL_EVENTS = "kross:bus:channel";
  public static final String WORKER_OFFER = "kross:bus:worker-offer";

  private final String instanceId = UUID.randomUUID().toString();
  private final ObjectMapper mapper;
  private final RedisConnectionFactory connectionFactory;
  private final StringRedisTemplate redis;
  private final ConcurrentHashMap<String, CopyOnWriteArrayList<Consumer<JsonNode>>> handlers =
      new ConcurrentHashMap<>();
  private final AtomicBoolean degraded = new AtomicBoolean(true);
  private RedisMessageListenerContainer container;

  public ClusterFanout(
      ObjectMapper mapper,
      ObjectProvider<RedisConnectionFactory> connectionFactories,
      ObjectProvider<StringRedisTemplate> redisTemplates) {
    this.mapper = mapper;
    this.connectionFactory = connectionFactories.getIfAvailable();
    this.redis = redisTemplates.getIfAvailable();
  }

  public String instanceId() {
    return instanceId;
  }

  public boolean isDegraded() {
    return degraded.get();
  }

  public void on(String topic, Consumer<JsonNode> handler) {
    Optional.ofNullable(handler).ifPresent(item ->
        handlers.computeIfAbsent(topic, key -> new CopyOnWriteArrayList<>()).add(item));
  }

  public void publish(String topic, Object body) {
    if (redis == null) {
      return;
    }
    try {
      Envelope envelope = new Envelope(instanceId, mapper.valueToTree(body));
      redis.convertAndSend(topic, mapper.writeValueAsString(envelope));
      markHealthy();
    } catch (Exception error) {
      if (isRedisFailure(error)) {
        markDegraded(error);
        return;
      }
      log.warn("Cluster fanout dropped a message on {}: {}", topic, error.getMessage());
    }
  }

  @Override
  public void afterPropertiesSet() {
    if (connectionFactory == null) {
      return;
    }
    try {
      RedisMessageListenerContainer started = new RedisMessageListenerContainer();
      started.setConnectionFactory(connectionFactory);
      started.setErrorHandler(error -> {
        if (isRedisFailure(error)) {
          markDegraded(error);
        } else {
          log.warn("Cluster fanout listener error: {}", error.getMessage());
        }
      });
      started.addMessageListener(
          this::onMessage,
          List.of(new ChannelTopic(CHANNEL_EVENTS), new ChannelTopic(WORKER_OFFER)));
      started.afterPropertiesSet();
      started.start();
      container = started;
    } catch (Exception error) {
      if (isRedisFailure(error)) {
        markDegraded(error);
        return;
      }
      log.warn("Cluster fanout listener did not start: {}", error.getMessage());
    }
  }

  @Override
  public void destroy() {
    RedisMessageListenerContainer started = container;
    container = null;
    if (started == null) {
      return;
    }
    try {
      started.stop();
      started.destroy();
    } catch (Exception ignored) {
      // shutdown is best-effort
    }
  }

  void onMessage(Message message, byte[] pattern) {
    String topic = new String(message.getChannel(), StandardCharsets.UTF_8);
    String payload = new String(message.getBody(), StandardCharsets.UTF_8);
    dispatch(topic, payload);
  }

  void dispatch(String topic, String payload) {
    Envelope envelope;
    try {
      envelope = mapper.readValue(payload, Envelope.class);
    } catch (Exception error) {
      log.warn("Cluster fanout ignored an undecodable message on {}: {}", topic, error.getMessage());
      return;
    }
    if (instanceId.equals(envelope.origin())) {
      return;
    }
    markHealthy();
    JsonNode body = Optional.ofNullable(envelope.body()).orElseGet(mapper::nullNode);
    CopyOnWriteArrayList<Consumer<JsonNode>> listeners = handlers.get(topic);
    if (listeners == null || listeners.isEmpty()) {
      return;
    }
    for (Consumer<JsonNode> listener : listeners) {
      try {
        listener.accept(body);
      } catch (RuntimeException error) {
        log.warn("Cluster fanout handler failed on {}: {}", topic, error.getMessage());
      }
    }
  }

  private void markDegraded(Throwable error) {
    if (degraded.compareAndSet(false, true)) {
      log.warn("Cluster fanout is unavailable, staying on in-process delivery: {}", error.getMessage());
    }
  }

  private void markHealthy() {
    if (degraded.compareAndSet(true, false)) {
      log.info("Cluster fanout recovered");
    }
  }

  static boolean isRedisFailure(Throwable error) {
    for (Throwable current = error; current != null; current = current.getCause()) {
      String type = current.getClass().getName();
      if (current instanceof java.net.ConnectException
          || type.startsWith("org.springframework.data.redis.")
          || type.startsWith("io.lettuce.core.")) {
        return true;
      }
    }
    return false;
  }

  public record Envelope(String origin, JsonNode body) {}
}
