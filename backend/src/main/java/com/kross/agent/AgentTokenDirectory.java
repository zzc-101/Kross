package com.kross.agent;

import com.kross.agent.entity.AgentSession;
import lombok.RequiredArgsConstructor;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;

/**
 * Caches agent token authentication keyed by the SHA-256 token hash. Raw
 * tokens never reach the cache. The short TTL bounds the window in which a
 * revoked or expired token still authenticates.
 */
@Service
@RequiredArgsConstructor
public class AgentTokenDirectory {

  private final AgentMapper agents;

  @Cacheable(cacheNames = "agentSessions", key = "#tokenHash", unless = "#result == null")
  public AgentSession findSession(String tokenHash) {
    return agents.authenticateToken(tokenHash).orElse(null);
  }
}
