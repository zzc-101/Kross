package com.kross.catalog;

import com.kross.catalog.entity.PlatformSkill;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;

/**
 * Cached read model for installed organization skills. Mutations in
 * {@link SkillCatalogService} evict these caches; TTLs bound staleness for
 * platform-level changes.
 */
@Service
@RequiredArgsConstructor
public class SkillDirectory {

  private final CatalogMapper catalog;

  @Cacheable(cacheNames = "orgSkills", key = "#organizationId", unless = "#result == null")
  public List<PlatformSkill> installedSkills(String organizationId) {
    return catalog.listInstalledSkills(organizationId);
  }

  @Cacheable(cacheNames = "orgSkill", key = "#organizationId + ':' + #skillId", unless = "#result == null")
  public PlatformSkill installedSkill(String organizationId, String skillId) {
    return catalog.findInstalledSkill(organizationId, skillId).orElse(null);
  }
}
