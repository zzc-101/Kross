package com.kross.connector;

import com.kross.api.ApiException;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Optional;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

@Component
public class ConnectorBindCodes {
  public static final Duration TTL = Duration.ofMinutes(10);
  private static final SecureRandom RANDOM = new SecureRandom();

  private final StringRedisTemplate redis;

  public ConnectorBindCodes(ObjectProvider<StringRedisTemplate> redis) {
    this.redis = redis.getIfAvailable();
  }

  public String issue(String channel, String userId, String organizationId) {
    StringRedisTemplate store = requireRedis();
    String payload = userId + " " + organizationId;
    for (int attempt = 0; attempt < 8; attempt++) {
      String code = nextCode();
      Boolean created = store.opsForValue().setIfAbsent(key(channel, code), payload, TTL);
      if (Boolean.TRUE.equals(created)) {
        return code;
      }
    }
    throw new ApiException("connector_unavailable", "Unable to issue a bind code", 503);
  }

  public Optional<BindingTarget> consume(String channel, String code) {
    StringRedisTemplate store = requireRedis();
    String normalized = Optional.ofNullable(code).map(String::trim).orElse("");
    if (!normalized.matches("\\d{6}")) {
      return Optional.empty();
    }
    String value = store.opsForValue().getAndDelete(key(channel, normalized));
    if (value == null || value.isBlank()) {
      return Optional.empty();
    }
    int split = value.indexOf(' ');
    if (split <= 0 || split == value.length() - 1) {
      return Optional.empty();
    }
    return Optional.of(new BindingTarget(value.substring(0, split), value.substring(split + 1)));
  }

  private StringRedisTemplate requireRedis() {
    return Optional.ofNullable(redis).orElseThrow(() ->
        new ApiException("connector_unavailable", "Bind codes require Redis", 503));
  }

  private static String key(String channel, String code) {
    return "app:bind:" + channel + ":" + code;
  }

  private static String nextCode() {
    return String.format("%06d", RANDOM.nextInt(1_000_000));
  }

  public record BindingTarget(String userId, String organizationId) {}
}
