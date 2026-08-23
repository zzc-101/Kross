package com.kross.catalog;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.api.ApiException;
import com.kross.catalog.dto.CreateSkillRequest;
import com.kross.catalog.dto.OrganizationSkillView;
import com.kross.catalog.dto.PlatformSkillView;
import com.kross.catalog.dto.UpdateSkillRequest;
import com.kross.catalog.entity.PlatformSkill;
import com.kross.identity.AuthService;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class SkillCatalogService {
  private static final int MAX_CONTENT_CHARS = 128_000;
  private final CatalogMapper catalog;
  private final OrganizationAccess access;
  private final AuthService auth;
  private final ObjectMapper mapper;

  public List<PlatformSkillView> listPlatformSkills() {
    auth.requireSuperAdmin();
    return catalog.listPlatformSkills().stream().map(SkillCatalogService::platformView).toList();
  }

  @Transactional
  public PlatformSkillView createPlatformSkill(CreateSkillRequest request) {
    auth.requireSuperAdmin();
    String id = requireId(request.id());
    String content = requireContent(request.content());
    Instant now = Instant.now();
    PlatformSkill row = new PlatformSkill(
        id,
        required(request.name(), "name", 100),
        optional(request.description(), 500),
        optionalOr(request.category(), "办公效率", 64),
        optionalOr(request.icon(), "sparkles", 64),
        launchMode(request.launchMode()),
        optional(request.starterPrompt(), 1_000),
        content,
        digest(content),
        1,
        "active",
        access.currentIdentity().userId(),
        now,
        now,
        0,
        false,
        null);
    try {
      catalog.insertPlatformSkill(row);
    } catch (DuplicateKeyException error) {
      throw ApiException.conflict("skill_exists", "Skill identifier already exists");
    }
    return catalog.findPlatformSkill(id).map(SkillCatalogService::platformView).orElseThrow();
  }

  @Transactional
  public PlatformSkillView updatePlatformSkill(String skillId, UpdateSkillRequest request) {
    auth.requireSuperAdmin();
    PlatformSkill row = catalog.findPlatformSkill(requireId(skillId))
        .orElseThrow(() -> ApiException.notFound("Skill"));
    Optional.ofNullable(request.name()).ifPresent(value -> row.setName(required(value, "name", 100)));
    Optional.ofNullable(request.description()).ifPresent(value -> row.setDescription(optional(value, 500)));
    Optional.ofNullable(request.category()).ifPresent(value -> row.setCategory(optionalOr(value, "办公效率", 64)));
    Optional.ofNullable(request.icon()).ifPresent(value -> row.setIcon(optionalOr(value, "sparkles", 64)));
    Optional.ofNullable(request.launchMode()).ifPresent(value -> row.setLaunchMode(launchMode(value)));
    Optional.ofNullable(request.starterPrompt()).ifPresent(value -> row.setStarterPrompt(optional(value, 1_000)));
    if (request.content() != null) {
      String content = requireContent(request.content());
      row.setContent(content);
      row.setContentDigest(digest(content));
    }
    if (request.status() != null) {
      String status = request.status().trim();
      if (!List.of("active", "disabled").contains(status)) {
        throw ApiException.invalidRequest("status must be active or disabled");
      }
      row.setStatus(status);
    }
    catalog.updatePlatformSkill(row);
    return catalog.findPlatformSkill(row.getId()).map(SkillCatalogService::platformView).orElseThrow();
  }

  public List<OrganizationSkillView> listOrganizationCatalog(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.SKILL_MANAGE);
    return catalog.listOrganizationSkillCatalog(context.organizationId()).stream()
        .map(SkillCatalogService::organizationView)
        .toList();
  }

  @Transactional
  public OrganizationSkillView install(String organizationId, String skillId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.SKILL_MANAGE);
    PlatformSkill skill = catalog.findPlatformSkill(requireId(skillId))
        .orElseThrow(() -> ApiException.notFound("Skill"));
    if (!"active".equals(skill.getStatus())) {
      throw ApiException.conflict("skill_disabled", "Skill is disabled by the platform");
    }
    catalog.installOrganizationSkill(
        context.organizationId(), skill.getId(), context.userId(), mapper.createObjectNode());
    catalog.insertAudit(
        context.organizationId(), context.userId(), "skill.install", "skill", skill.getId(),
        mapper.createObjectNode().put("revision", skill.getRevision()));
    return catalog.findOrganizationSkill(context.organizationId(), skill.getId())
        .map(SkillCatalogService::organizationView)
        .orElseThrow();
  }

  @Transactional
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
    return catalog.listInstalledSkills(organizationId);
  }

  public Optional<PlatformSkill> findInstalledSkill(String organizationId, String skillId) {
    return catalog.findInstalledSkill(organizationId, requireId(skillId));
  }

  private static PlatformSkillView platformView(PlatformSkill row) {
    return new PlatformSkillView(
        row.getId(), row.getName(), row.getDescription(), row.getCategory(), row.getIcon(), row.getLaunchMode(),
        row.getStarterPrompt(), row.getContent(), row.getRevision(), row.getStatus(),
        Optional.ofNullable(row.getInstallCount()).orElse(0), row.getCreatedAt(), row.getUpdatedAt());
  }

  private static OrganizationSkillView organizationView(PlatformSkill row) {
    return new OrganizationSkillView(
        row.getId(), row.getName(), row.getDescription(), row.getCategory(), row.getIcon(), row.getLaunchMode(),
        row.getStarterPrompt(), row.getRevision(), row.getStatus(), Boolean.TRUE.equals(row.getInstalled()),
        row.getInstalledAt());
  }

  private static String requireId(String value) {
    String id = Optional.ofNullable(value).map(String::trim).orElse("");
    if (!id.matches("^[a-z][a-z0-9-]{1,63}$")) {
      throw ApiException.invalidRequest("Skill id must use 2-64 lowercase letters, digits, or hyphens");
    }
    return id;
  }

  private static String requireContent(String value) {
    String content = Optional.ofNullable(value).orElse("").trim();
    if (content.isEmpty()) throw ApiException.invalidRequest("Skill content is required");
    if (content.length() > MAX_CONTENT_CHARS) throw ApiException.invalidRequest("Skill content is too long");
    return content;
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

  private static String digest(String content) {
    try {
      return HexFormat.of().formatHex(
          MessageDigest.getInstance("SHA-256").digest(content.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception error) {
      throw new IllegalStateException("Unable to digest Skill", error);
    }
  }
}
