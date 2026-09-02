package com.kross.config;

import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.ModelCatalog;
import com.kross.agent.entity.AgentSession;
import com.kross.cache.FaultTolerantCacheManager;
import com.kross.catalog.SkillDirectory;
import com.kross.catalog.entity.PlatformSkill;
import com.kross.identity.IdentityDirectory;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.cache.CacheManager;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.cache.support.NoOpCacheManager;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.cache.RedisCacheConfiguration;
import org.springframework.data.redis.cache.RedisCacheManager;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.serializer.Jackson2JsonRedisSerializer;
import org.springframework.data.redis.serializer.RedisSerializationContext;

/**
 * Shared Redis cache for hot, slow-changing reads (identity, authorization,
 * catalogs). Values are serialized with per-cache concrete types so no
 * polymorphic type information is embedded; sensitive columns such as
 * password hashes and credential ciphertexts must never enter these caches.
 *
 * TTLs double as the consistency bound in cluster deployments: role changes,
 * suspensions and token revocations take effect at most one TTL late unless
 * an explicit eviction runs on the mutating path.
 */
@Configuration
@EnableCaching
public class CacheConfig {

  public static final String USERS = "users";
  public static final String ORGANIZATIONS = "organizations";
  public static final String MEMBERSHIPS = "memberships";
  public static final String AGENT_SESSIONS = "agentSessions";
  public static final String ORG_SKILLS = "orgSkills";
  public static final String ORG_SKILL = "orgSkill";
  public static final String MODELS = "models";
  public static final String MODEL_LIST = "modelList";

  private static final Duration IDENTITY_TTL = Duration.ofSeconds(60);
  private static final Duration AGENT_SESSION_TTL = Duration.ofSeconds(30);
  private static final Duration CATALOG_TTL = Duration.ofMinutes(5);

  @Bean
  @ConditionalOnProperty(prefix = "app.cache", name = "enabled", havingValue = "true", matchIfMissing = true)
  public CacheManager redisCacheManager(RedisConnectionFactory connectionFactory, ObjectMapper objectMapper) {
    RedisCacheConfiguration base = RedisCacheConfiguration.defaultCacheConfig()
        .computePrefixWith(name -> "app:cache:" + name + ":")
        .disableCachingNullValues();

    Map<String, RedisCacheConfiguration> caches = new LinkedHashMap<>();
    caches.put(USERS, cache(base, objectMapper, IdentityDirectory.CachedUser.class, IDENTITY_TTL));
    caches.put(ORGANIZATIONS, cache(base, objectMapper, String.class, IDENTITY_TTL));
    caches.put(MEMBERSHIPS, cache(base, objectMapper, IdentityDirectory.MembershipGrant.class, IDENTITY_TTL));
    caches.put(AGENT_SESSIONS, cache(base, objectMapper, AgentSession.class, AGENT_SESSION_TTL));
    caches.put(MODELS, cache(base, objectMapper, ModelCatalog.UsableModel.class, CATALOG_TTL));
    caches.put(MODEL_LIST, cache(base, objectMapper, listOf(objectMapper, ModelCatalog.UsableModel.class), CATALOG_TTL));
    caches.put(ORG_SKILLS, cache(base, objectMapper, listOf(objectMapper, PlatformSkill.class), CATALOG_TTL));
    caches.put(ORG_SKILL, cache(base, objectMapper, PlatformSkill.class, CATALOG_TTL));

    RedisCacheManager redis = RedisCacheManager.builder(connectionFactory)
        .cacheDefaults(base)
        .withInitialCacheConfigurations(caches)
        .transactionAware()
        .build();
    return new FaultTolerantCacheManager(redis);
  }

  @Bean
  @ConditionalOnProperty(prefix = "app.cache", name = "enabled", havingValue = "false")
  public CacheManager noOpCacheManager() {
    return new NoOpCacheManager();
  }

  private RedisCacheConfiguration cache(
      RedisCacheConfiguration base, ObjectMapper objectMapper, Class<?> viewType, Duration ttl) {
    return serializer(base, new Jackson2JsonRedisSerializer<>(objectMapper, viewType), ttl);
  }

  private RedisCacheConfiguration cache(
      RedisCacheConfiguration base, ObjectMapper objectMapper, JavaType type, Duration ttl) {
    return serializer(base, new Jackson2JsonRedisSerializer<>(objectMapper, type), ttl);
  }

  private JavaType listOf(ObjectMapper objectMapper, Class<?> elementType) {
    return objectMapper.getTypeFactory().constructCollectionType(List.class, elementType);
  }

  private RedisCacheConfiguration serializer(RedisCacheConfiguration base, Jackson2JsonRedisSerializer<?> serializer, Duration ttl) {
    return base
        .entryTtl(ttl)
        .serializeValuesWith(RedisSerializationContext.SerializationPair.fromSerializer(serializer));
  }
}
