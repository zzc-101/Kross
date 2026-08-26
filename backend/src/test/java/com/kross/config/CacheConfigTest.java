package com.kross.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.identity.IdentityDirectory;
import com.kross.cache.FaultTolerantCacheManager;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.data.redis.cache.RedisCache;
import org.springframework.data.redis.cache.RedisCacheConfiguration;
import org.springframework.data.redis.connection.RedisConnectionFactory;

/**
 * Regression test: the fault-tolerant wrapper must forward bean lifecycle
 * callbacks to RedisCacheManager. If afterPropertiesSet is swallowed, the
 * manager never pre-creates configured caches and silently serves every
 * cache with JDK serialization and no TTL.
 */
class CacheConfigTest {

  @Test
  void perCacheConfigurationSurvivesTheFaultTolerantWrapper() throws Exception {
    CacheManager manager = new CacheConfig()
        .redisCacheManager(mock(RedisConnectionFactory.class), new ObjectMapper());

    assertThat(manager).isInstanceOf(FaultTolerantCacheManager.class);
    ((org.springframework.beans.factory.InitializingBean) manager).afterPropertiesSet();

    RedisCache users = unwrap(manager.getCache(CacheConfig.USERS));
    RedisCacheConfiguration configuration = configurationOf(users);

    assertThat(configuration.getTtl()).isEqualTo(Duration.ofSeconds(60));
    Object encoded = configuration.getValueSerializationPair()
        .write(new IdentityDirectory.CachedUser("u-1", "alice", "Alice", "user", "active"));
    java.nio.ByteBuffer buffer = (java.nio.ByteBuffer) encoded;
    assertThat(new java.lang.String(buffer.array(), buffer.position(), buffer.remaining(),
        java.nio.charset.StandardCharsets.UTF_8)).startsWith("{");

    RedisCache agentSessions = unwrap(manager.getCache(CacheConfig.AGENT_SESSIONS));
    assertThat(configurationOf(agentSessions).getTtl()).isEqualTo(Duration.ofSeconds(30));

    RedisCache models = unwrap(manager.getCache(CacheConfig.MODELS));
    assertThat(configurationOf(models).getTtl()).isEqualTo(Duration.ofMinutes(5));
  }

  private static RedisCache unwrap(Cache cache) {
    Cache current = cache;
    while (true) {
      if (current instanceof org.springframework.cache.transaction.TransactionAwareCacheDecorator decorator) {
        current = decorator.getTargetCache();
      } else if (current.getClass().getSimpleName().equals("FaultTolerantCache")) {
        current = (Cache) fieldOf(current, "target");
      } else {
        break;
      }
    }
    return (RedisCache) current;
  }

  private static Object fieldOf(Object owner, String name) {
    try {
      java.lang.reflect.Field field = owner.getClass().getDeclaredField(name);
      field.setAccessible(true);
      return field.get(owner);
    } catch (ReflectiveOperationException error) {
      throw new IllegalStateException(error);
    }
  }

  private static RedisCacheConfiguration configurationOf(RedisCache cache) throws Exception {
    for (Class<?> type = cache.getClass(); type != null; type = type.getSuperclass()) {
      for (java.lang.reflect.Field field : type.getDeclaredFields()) {
        if (field.getType() == RedisCacheConfiguration.class) {
          field.setAccessible(true);
          return (RedisCacheConfiguration) field.get(cache);
        }
      }
    }
    throw new IllegalStateException("no RedisCacheConfiguration field on " + cache.getClass());
  }
}
