package com.kross.catalog;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.api.ApiException;
import com.kross.catalog.dto.CreateSkillRequest;
import com.kross.catalog.dto.OrganizationSkillView;
import com.kross.catalog.dto.PlatformSkillView;
import com.kross.catalog.dto.SkillPackageDownloadView;
import com.kross.catalog.dto.SkillVersionView;
import com.kross.catalog.dto.UpdateSkillRequest;
import com.kross.catalog.entity.PlatformSkill;
import com.kross.catalog.entity.PlatformSkillVersion;
import com.kross.identity.AuthService;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import com.kross.storage.ObjectStorage;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

@Service
@RequiredArgsConstructor
public class SkillCatalogService {
  private final CatalogMapper catalog;
  private final OrganizationAccess access;
  private final AuthService auth;
  private final ObjectMapper mapper;
  private final SkillPackageArtifactService artifacts;
  private final ObjectStorage storage;
  private final SkillDirectory directory;

  public List<PlatformSkillView> listPlatformSkills() {
    auth.requireSuperAdmin();
    return catalog.listPlatformSkills().stream().map(SkillCatalogService::platformView).toList();
  }

  @Transactional
  @CacheEvict(cacheNames = {"orgSkills", "orgSkill"}, allEntries = true)
  public PlatformSkillView createPlatformSkill(CreateSkillRequest request, MultipartFile file) {
    auth.requireSuperAdmin();
    String id = requireId(request.id());
    SkillPackageArtifactService.Artifact artifact = artifacts.validateAndStore(readPackage(file));
    Instant now = Instant.now();
    PlatformSkill row = new PlatformSkill();
    row.setId(id);
    row.setName(required(request.name(), "name", 100));
    row.setDescription(optional(request.description(), 500));
    row.setCategory(optionalOr(request.category(), "办公效率", 64));
    row.setIcon(optionalOr(request.icon(), "sparkles", 64));
    row.setLaunchMode(launchMode(request.launchMode()));
    row.setStarterPrompt(optional(request.starterPrompt(), 1_000));
    row.setStatus("draft");
    row.setCreatedBy(access.currentIdentity().userId());
    row.setCreatedAt(now);
    row.setUpdatedAt(now);
    try {
      catalog.insertPlatformSkill(row);
      insertVersion(row, 1, artifact, request.changelog());
    } catch (DuplicateKeyException error) {
      throw ApiException.conflict("skill_exists", "Skill identifier already exists");
    }
    return catalog.findPlatformSkill(id).map(SkillCatalogService::platformView).orElseThrow();
  }

  @Transactional
  @CacheEvict(cacheNames = {"orgSkills", "orgSkill"}, allEntries = true)
  public PlatformSkillView updatePlatformSkill(String skillId, UpdateSkillRequest request) {
    auth.requireSuperAdmin();
    PlatformSkill row = requireSkill(skillId);
    Optional.ofNullable(request.name()).ifPresent(value -> row.setName(required(value, "name", 100)));
    Optional.ofNullable(request.description()).ifPresent(value -> row.setDescription(optional(value, 500)));
    Optional.ofNullable(request.category()).ifPresent(value -> row.setCategory(optionalOr(value, "办公效率", 64)));
    Optional.ofNullable(request.icon()).ifPresent(value -> row.setIcon(optionalOr(value, "sparkles", 64)));
    Optional.ofNullable(request.launchMode()).ifPresent(value -> row.setLaunchMode(launchMode(value)));
    Optional.ofNullable(request.starterPrompt()).ifPresent(value -> row.setStarterPrompt(optional(value, 1_000)));
    if (request.status() != null) {
      String status = request.status().trim();
      if (!List.of("active", "disabled").contains(status)) {
        throw ApiException.invalidRequest("status must be active or disabled");
      }
      if ("active".equals(status) && row.getActiveVersionId() == null) {
        throw ApiException.conflict("skill_not_published", "Publish a Skill version before enabling it");
      }
      row.setStatus(status);
    }
    catalog.updatePlatformSkill(row);
    return catalog.findPlatformSkill(row.getId()).map(SkillCatalogService::platformView).orElseThrow();
  }

  @Transactional
  @CacheEvict(cacheNames = {"orgSkills", "orgSkill"}, allEntries = true)
  public void deletePlatformSkill(String skillId) {
    auth.requireSuperAdmin();
    PlatformSkill skill = requireSkill(skillId);
    if (Optional.ofNullable(skill.getInstallCount()).orElse(0) > 0) {
      throw ApiException.conflict("skill_installed", "Uninstall this Skill from all organizations before deleting it");
    }
    catalog.deletePlatformSkill(skill.getId());
  }

  @Transactional
  public SkillVersionView createVersion(String skillId, String changelog, MultipartFile file) {
    auth.requireSuperAdmin();
    PlatformSkill skill = requireSkill(skillId);
    SkillPackageArtifactService.Artifact artifact = artifacts.validateAndStore(readPackage(file));
    long version = catalog.nextSkillVersion(skill.getId());
    PlatformSkillVersion created = insertVersion(skill, version, artifact, changelog);
    return versionView(created);
  }

  public List<SkillVersionView> listVersions(String skillId) {
    auth.requireSuperAdmin();
    PlatformSkill skill = requireSkill(skillId);
    return catalog.listSkillVersions(skill.getId()).stream().map(SkillCatalogService::versionView).toList();
  }

  @Transactional
  @CacheEvict(cacheNames = {"orgSkills", "orgSkill"}, allEntries = true)
  public PlatformSkillView publishVersion(String skillId, long version) {
    auth.requireSuperAdmin();
    PlatformSkill skill = requireSkill(skillId);
    PlatformSkillVersion target = requireVersion(skill.getId(), version);
    catalog.publishSkillVersion(skill.getId(), target.getId());
    catalog.markSkillVersionPublished(target.getId());
    return catalog.findPlatformSkill(skill.getId()).map(SkillCatalogService::platformView).orElseThrow();
  }

  @Transactional
  public SkillPackageDownloadView downloadVersion(String skillId, long version) {
    auth.requireSuperAdmin();
    PlatformSkill skill = requireSkill(skillId);
    PlatformSkillVersion target = requireVersion(skill.getId(), version);
    if (target.getPackageKey() == null || target.getPackageKey().isBlank()) {
      SkillPackageArtifactService.Artifact artifact = artifacts.storeLegacyPackage(
          skill.getId(), skill.getName(), skill.getDescription(), target.getSkillMd());
      catalog.updateSkillVersionPackage(
          target.getId(), artifact.key(), artifact.sha256(), artifact.sizeBytes(), artifact.manifest());
      target.setPackageKey(artifact.key());
    }
    Instant expiresAt = Instant.now().plus(Duration.ofMinutes(10));
    ObjectStorage.SignedUrl signed = storage.presignGet(
        target.getPackageKey(), ObjectStorage.Audience.PUBLIC, expiresAt);
    return new SkillPackageDownloadView(signed.url(), signed.expiresAt());
  }

  public List<OrganizationSkillView> listOrganizationCatalog(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.SKILL_MANAGE);
    return catalog.listOrganizationSkillCatalog(context.organizationId()).stream()
        .map(SkillCatalogService::organizationView)
        .toList();
  }

  @Transactional
  @CacheEvict(cacheNames = {"orgSkills", "orgSkill"}, allEntries = true)
  public OrganizationSkillView install(String organizationId, String skillId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.SKILL_MANAGE);
    PlatformSkill skill = requireSkill(skillId);
    if (!"active".equals(skill.getStatus()) || skill.getActiveVersionId() == null) {
      throw ApiException.conflict("skill_unavailable", "Skill has no active published version");
    }
    catalog.installOrganizationSkill(
        context.organizationId(), skill.getId(), context.userId(), mapper.createObjectNode());
    catalog.insertAudit(
        context.organizationId(), context.userId(), "skill.install", "skill", skill.getId(),
        mapper.createObjectNode().put("version", skill.getRevision()));
    return catalog.findOrganizationSkill(context.organizationId(), skill.getId())
        .map(SkillCatalogService::organizationView)
        .orElseThrow();
  }

  @Transactional
  @CacheEvict(cacheNames = {"orgSkills", "orgSkill"}, allEntries = true)
  public void uninstall(String organizationId, String skillId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.SKILL_MANAGE);
    if (catalog.uninstallOrganizationSkill(context.organizationId(), requireId(skillId)) == 0) {
      throw ApiException.notFound("Skill installation");
    }
    catalog.insertAudit(
        context.organizationId(), context.userId(), "skill.uninstall", "skill", skillId,
        mapper.createObjectNode());
  }

  public List<PlatformSkill> listInstalledSkills(String organizationId) {
    access.require(organizationId, OrganizationAction.AGENT_READ);
    return directory.installedSkills(organizationId);
  }

  public Optional<PlatformSkill> findInstalledSkill(String organizationId, String skillId) {
    return Optional.ofNullable(directory.installedSkill(organizationId, requireId(skillId)));
  }

  private PlatformSkillVersion insertVersion(
      PlatformSkill skill, long version, SkillPackageArtifactService.Artifact artifact, String changelog) {
    PlatformSkillVersion row = new PlatformSkillVersion(
        skill.getId() + ":v" + version,
        skill.getId(), version, artifact.key(), artifact.sha256(), artifact.sizeBytes(),
        artifact.skillMd(), SkillPackageArtifactService.digest(artifact.skillMd()), artifact.manifest(),
        optional(changelog, 2_000), access.currentIdentity().userId(), Instant.now(), null, false);
    catalog.insertSkillVersion(row);
    return row;
  }

  private PlatformSkill requireSkill(String skillId) {
    return catalog.findPlatformSkill(requireId(skillId))
        .orElseThrow(() -> ApiException.notFound("Skill"));
  }

  private PlatformSkillVersion requireVersion(String skillId, long version) {
    if (version <= 0) throw ApiException.invalidRequest("Skill version must be positive");
    return catalog.findSkillVersion(skillId, version)
        .orElseThrow(() -> ApiException.notFound("Skill version"));
  }

  private static PlatformSkillView platformView(PlatformSkill row) {
    return new PlatformSkillView(
        row.getId(), row.getName(), row.getDescription(), row.getCategory(), row.getIcon(), row.getLaunchMode(),
        row.getStarterPrompt(), row.getRevision(), row.getLatestVersion(),
        Optional.ofNullable(row.getVersionCount()).orElse(0), emptyToNull(row.getPackageSha256()),
        Optional.ofNullable(row.getPackageSizeBytes()).orElse(0L), row.getStatus(),
        Optional.ofNullable(row.getInstallCount()).orElse(0), row.getCreatedAt(), row.getUpdatedAt());
  }

  private static OrganizationSkillView organizationView(PlatformSkill row) {
    return new OrganizationSkillView(
        row.getId(), row.getName(), row.getDescription(), row.getCategory(), row.getIcon(), row.getLaunchMode(),
        row.getStarterPrompt(), row.getRevision(), row.getStatus(), Boolean.TRUE.equals(row.getInstalled()),
        row.getInstalledAt());
  }

  private static SkillVersionView versionView(PlatformSkillVersion row) {
    return new SkillVersionView(
        row.getVersion(), row.getPackageSha256(), row.getPackageSizeBytes(), row.getManifest(),
        row.getChangelog(), Boolean.TRUE.equals(row.getActive()), row.getCreatedAt(), row.getPublishedAt());
  }

  private static byte[] readPackage(MultipartFile file) {
    if (file == null || file.isEmpty()) throw ApiException.invalidRequest("Skill ZIP package is required");
    if (file.getSize() > SkillPackageArtifactService.MAX_PACKAGE_BYTES) {
      throw ApiException.invalidRequest("Skill ZIP package must not exceed 10 MB");
    }
    try {
      return file.getBytes();
    } catch (Exception error) {
      throw ApiException.invalidRequest("Unable to read Skill ZIP package");
    }
  }

  private static String requireId(String value) {
    String id = Optional.ofNullable(value).map(String::trim).orElse("");
    if (!id.matches("^[a-z][a-z0-9-]{1,63}$")) {
      throw ApiException.invalidRequest("Skill id must use 2-64 lowercase letters, digits, or hyphens");
    }
    return id;
  }

  private static String required(String value, String field, int max) {
    String normalized = Optional.ofNullable(value).map(String::trim).orElse("");
    if (normalized.isEmpty()) throw ApiException.invalidRequest("Missing " + field);
    if (normalized.length() > max) throw ApiException.invalidRequest(field + " is too long");
    return normalized;
  }

  private static String optional(String value, int max) {
    String normalized = Optional.ofNullable(value).map(String::trim).orElse("");
    if (normalized.length() > max) throw ApiException.invalidRequest("Field is too long");
    return normalized;
  }

  private static String optionalOr(String value, String fallback, int max) {
    String normalized = optional(value, max);
    return normalized.isEmpty() ? fallback : normalized;
  }

  private static String launchMode(String value) {
    String mode = Optional.ofNullable(value).map(String::trim).filter(item -> !item.isEmpty()).orElse("instant");
    if (!List.of("instant", "form", "file").contains(mode)) {
      throw ApiException.invalidRequest("launchMode must be instant, form, or file");
    }
    return mode;
  }

  private static String emptyToNull(String value) {
    return value == null || value.isBlank() ? null : value;
  }
}
