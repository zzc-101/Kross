package com.kross.cache;

import java.util.Collection;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;

/**
 * Wraps the Redis cache manager so that a Redis outage degrades to direct
 * database reads instead of failing requests. The cache is an accelerator:
 * callers must never depend on its availability.
 *
 * <p>Bean lifecycle callbacks are delegated to the wrapped manager; without
 * this, {@code afterPropertiesSet} never reaches RedisCacheManager, which
 * then skips pre-creating configured caches and serves every cache from the
 * default configuration (JDK serialization, no TTL).
 */
@Slf4j
public class FaultTolerantCacheManager implements CacheManager, InitializingBean, DisposableBean {

  private final CacheManager target;
  private final Set<String> degraded = ConcurrentHashMap.newKeySet();

  public FaultTolerantCacheManager(CacheManager target) {
    this.target = target;
  }

  @Override
  public void afterPropertiesSet() throws Exception {
    if (target instanceof InitializingBean initializing) {
      initializing.afterPropertiesSet();
    }
  }

  @Override
  public void destroy() throws Exception {
    if (target instanceof DisposableBean disposable) {
      disposable.destroy();
    }
  }

  @Override
  public Cache getCache(String name) {
    Cache cache = target.getCache(name);
    return cache == null ? null : new FaultTolerantCache(name, cache);
  }

  @Override
  public Collection<String> getCacheNames() {
    return target.getCacheNames();
  }

  private class FaultTolerantCache implements Cache {

    private final String name;
    private final Cache target;

    private FaultTolerantCache(String name, Cache target) {
      this.name = name;
      this.target = target;
    }

    @Override
    public String getName() {
      return name;
    }

    @Override
    public Object getNativeCache() {
      return target.getNativeCache();
    }

    @Override
    public ValueWrapper get(Object key) {
      return recover(() -> target.get(key));
    }

    @Override
    public <T> T get(Object key, Class<T> type) {
      return recover(() -> target.get(key, type));
    }

    @Override
    public <T> T get(Object key, Callable<T> valueLoader) {
      try {
        markHealthy();
        return target.get(key, valueLoader);
      } catch (RuntimeException error) {
        if (!isRedisFailure(error)) {
          throw error;
        }
        markDegraded(error);
        try {
          return valueLoader.call();
        } catch (Exception loaderError) {
          sneakyThrow(loaderError);
          return null;
        }
      }
    }

    @Override
    public void put(Object key, Object value) {
      swallow(() -> target.put(key, value));
    }

    @Override
    public ValueWrapper putIfAbsent(Object key, Object value) {
      return recover(() -> target.putIfAbsent(key, value));
    }

    @Override
    public void evict(Object key) {
      swallow(() -> target.evict(key));
    }

    @Override
    public boolean evictIfPresent(Object key) {
      Boolean result = recover(() -> target.evictIfPresent(key));
      return Boolean.TRUE.equals(result);
    }

    @Override
    public void clear() {
      swallow(target::clear);
    }

    @Override
    public boolean invalidate() {
      Boolean result = recover(target::invalidate);
      return Boolean.TRUE.equals(result);
    }

    private <T> T recover(CacheCall<T> call) {
      try {
        T result = call.invoke();
        markHealthy();
        return result;
      } catch (RuntimeException error) {
        if (!isRedisFailure(error)) {
          throw error;
        }
        markDegraded(error);
        return null;
      }
    }

    private void swallow(Runnable action) {
      try {
        action.run();
        markHealthy();
      } catch (RuntimeException error) {
        if (!isRedisFailure(error)) {
          throw error;
        }
        markDegraded(error);
      }
    }

    private boolean isRedisFailure(RuntimeException error) {
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

    private void markDegraded(RuntimeException error) {
      if (degraded.add(name)) {
        log.warn("Cache [{}] is unavailable, falling back to database reads: {}", name, error.getMessage());
      }
    }

    private void markHealthy() {
      if (degraded.remove(name)) {
        log.info("Cache [{}] recovered", name);
      }
    }

    @SuppressWarnings("unchecked")
    private static <E extends Exception> void sneakyThrow(Throwable error) throws E {
      throw (E) error;
    }

    @FunctionalInterface
    private interface CacheCall<T> {
      T invoke();
    }
  }
}
