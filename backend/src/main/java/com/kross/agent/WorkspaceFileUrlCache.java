package com.kross.agent;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

@Component
class WorkspaceFileUrlCache {
  private static final Duration TTL = Duration.ofMinutes(2);
  private static final Duration EXPIRY_SKEW = Duration.ofSeconds(15);

  private final ConcurrentHashMap<String, Entry> entries = new ConcurrentHashMap<>();

  Optional<String> lookup(String organizationId, String agentId, String path, boolean inline) {
    purgeExpired();
    return Optional.ofNullable(entries.get(key(organizationId, agentId, path, inline)))
        .filter(entry -> Instant.now().isBefore(entry.usableUntil()))
        .map(Entry::url);
  }

  void store(
      String organizationId, String agentId, String path, boolean inline, String url, Instant signedExpiry) {
    Instant usableUntil = Instant.now().plus(TTL);
    if (signedExpiry != null && signedExpiry.minus(EXPIRY_SKEW).isBefore(usableUntil)) {
      usableUntil = signedExpiry.minus(EXPIRY_SKEW);
    }
    if (!usableUntil.isAfter(Instant.now())) {
      return;
    }
    entries.put(key(organizationId, agentId, path, inline), new Entry(url, usableUntil));
  }

  void evict(String organizationId, String agentId, String path) {
    entries.remove(key(organizationId, agentId, path, true));
    entries.remove(key(organizationId, agentId, path, false));
  }

  private void purgeExpired() {
    Instant now = Instant.now();
    entries.entrySet().removeIf(item -> !now.isBefore(item.getValue().usableUntil()));
  }

  private static String key(String organizationId, String agentId, String path, boolean inline) {
    return organizationId + "\n" + agentId + "\n" + path + "\n" + inline;
  }

  private record Entry(String url, Instant usableUntil) {}
}
