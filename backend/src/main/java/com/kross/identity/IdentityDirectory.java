package com.kross.identity;

import com.kross.identity.entity.Organization;
import com.kross.identity.entity.User;
import lombok.RequiredArgsConstructor;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;

/**
 * Redis-backed read model for the per-request identity and authorization
 * lookups. Only sanitized, non-sensitive fields are cached; TTLs in
 * {@link com.kross.config.CacheConfig} bound staleness for suspensions,
 * role changes and profile updates.
 */
@Service
@RequiredArgsConstructor
public class IdentityDirectory {

  private final IdentityMapper identities;

  public record CachedUser(String id, String username, String displayName, String platformRole, String status) {}

  public record MembershipGrant(String membershipId, String role) {}

  @Cacheable(cacheNames = "users", key = "#userId", unless = "#result == null")
  public CachedUser findUser(String userId) {
    return identities.findUserById(userId)
        .map(IdentityDirectory::toCachedUser)
        .orElse(null);
  }

  /** Returns the organization status, or {@code null} when missing or not active. */
  @Cacheable(cacheNames = "organizations", key = "#organizationId", unless = "#result == null")
  public String activeOrganizationStatus(String organizationId) {
    return identities.findOrganization(organizationId)
        .filter(organization -> "active".equals(organization.getStatus()))
        .map(Organization::getStatus)
        .orElse(null);
  }

  /** Returns the active membership grant, or {@code null} when absent or not active. */
  @Cacheable(cacheNames = "memberships", key = "#organizationId + ':' + #userId", unless = "#result == null")
  public MembershipGrant activeMembership(String organizationId, String userId) {
    return identities.findActiveMembership(organizationId, userId)
        .map(membership -> new MembershipGrant(membership.getId(), membership.getRole()))
        .orElse(null);
  }

  private static CachedUser toCachedUser(User user) {
    return new CachedUser(
        user.getId(), user.getUsername(), user.getDisplayName(), user.getPlatformRole(), user.getStatus());
  }
}
