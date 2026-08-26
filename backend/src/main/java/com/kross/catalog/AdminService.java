package com.kross.catalog;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.kross.agent.AgentService;
import com.kross.agent.entity.AgentRuntimeRow;
import com.kross.agent.entity.UsageCounts;
import com.kross.api.ApiException;
import com.kross.api.PageResponse;
import com.kross.catalog.dto.AuditEventView;
import com.kross.catalog.dto.CatalogViews;
import com.kross.catalog.dto.CreateModelRequest;
import com.kross.catalog.dto.ModelProfileView;
import com.kross.catalog.dto.TokenUsageRankView;
import com.kross.catalog.dto.TokenUsageTrendView;
import com.kross.catalog.dto.TokenUsageView;
import com.kross.catalog.dto.UpdateModelRequest;
import com.kross.catalog.entity.AuditEvent;
import com.kross.catalog.entity.CredentialHandle;
import com.kross.catalog.entity.ModelProfile;
import com.kross.catalog.entity.TokenUsageTotals;
import com.kross.channel.AgentSocketHub;
import com.kross.fleet.WorkerNode;
import com.kross.fleet.WorkerNodeMapper;
import com.kross.identity.AuthService;
import com.kross.identity.IdentityMapper;
import com.kross.identity.MembershipRole;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import com.kross.identity.Rbac;
import com.kross.identity.dto.AgentRuntimeView;
import com.kross.identity.dto.CreatedInviteView;
import com.kross.identity.dto.CreateInviteRequest;
import com.kross.identity.dto.DashboardResponse;
import com.kross.identity.dto.IdentityViews;
import com.kross.identity.dto.InviteMemberRequest;
import com.kross.identity.dto.InviteView;
import com.kross.identity.dto.MemberRemoved;
import com.kross.identity.dto.MemberView;
import com.kross.identity.dto.NodeHealthView;
import com.kross.identity.dto.UpdateMemberRequest;
import com.kross.identity.dto.UsageView;
import com.kross.identity.entity.Member;
import com.kross.identity.entity.OrganizationInvite;
import com.kross.identity.entity.User;
import com.kross.support.Ids;
import com.kross.support.Tokens;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class AdminService {
  private final OrganizationAccess access;
  private final IdentityMapper identities;
  private final AuthService auth;
  private final AgentService agents;
  private final CatalogMapper catalog;
  private final CredentialVault vault;
  private final ObjectMapper mapper;
  private final AgentSocketHub sockets;
  private final WorkerNodeMapper nodes;

  public DashboardResponse dashboard(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AUDIT_READ);
    UsageCounts usage = agents.usageCounts(context.organizationId());
    List<AgentRuntimeView> runtimes = agents.listRuntimes(context.organizationId()).stream()
        .map(row -> toRuntimeView(row))
        .toList();
    Instant onlineSince = Instant.now().minus(Duration.ofMinutes(2));
    List<NodeHealthView> nodeViews = nodes.listAll().stream()
        .map(node -> toNodeView(node, onlineSince))
        .toList();
    return new DashboardResponse(
        IdentityViews.counts(identities.dashboardCounts(context.organizationId())),
        new UsageView(
            Optional.ofNullable(usage.getMessages1d()).orElse(0),
            Optional.ofNullable(usage.getMessages7d()).orElse(0)),
        runtimes,
        nodeViews);
  }

  @Transactional
  public CreatedInviteView createInvite(String organizationId, CreateInviteRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.MEMBERSHIP_INVITE);
    MembershipRole invited = MembershipRole.fromWire(Optional.ofNullable(request.role()).orElse("member"));
    if (!Rbac.canManageRole(context.role(), invited)) {
      throw new ApiException("permission_denied", "Role cannot manage the requested membership", 403);
    }
    if (identities.countActiveInvites(context.organizationId()) >= 50) {
      throw ApiException.conflict("invite_limit", "Too many active invite links");
    }
    int days = Optional.ofNullable(request.expiresInDays()).orElse(14);
    if (days < 1 || days > 90) {
      throw ApiException.invalidRequest("expiresInDays must be 1-90");
    }
    String token = Tokens.randomSecret();
    OrganizationInvite row = new OrganizationInvite();
    row.setId(UUID.randomUUID().toString());
    row.setOrganizationId(context.organizationId());
    row.setTokenHash(Tokens.sha256Hex(token));
    row.setRole(invited.wire());
    row.setCreatedBy(context.userId());
    row.setExpiresAt(Instant.now().plus(Duration.ofDays(days)));
    identities.insertInvite(row);
    catalog.insertAudit(
        context.organizationId(),
        context.userId(),
        "membership.invite_link",
        "invite",
        row.getId(),
        mapper.createObjectNode().put("role", invited.wire()));
    return new CreatedInviteView(row.getId(), token, invited.wire(), row.getExpiresAt(), "/invite/" + token);
  }

  private AgentRuntimeView toRuntimeView(AgentRuntimeRow row) {
    return new AgentRuntimeView(
        row.getId(),
        row.getUserId(),
        row.getUsername(),
        row.getDisplayName(),
        row.getStatus(),
        row.getNodeId(),
        row.getLastError(),
        row.getLastActiveAt(),
        sockets.isConnected(row.getId()));
  }

  private static NodeHealthView toNodeView(WorkerNode node, Instant onlineSince) {
    boolean connected = "online".equals(node.getStatus())
        && Optional.ofNullable(node.getLastSeenAt()).filter(seen -> !seen.isBefore(onlineSince)).isPresent();
    return new NodeHealthView(
        node.getId(),
        node.getHostname(),
        node.getStatus(),
        node.getRunningAgents(),
        node.isJuicefsOk(),
        node.getLastSeenAt(),
        connected);
  }

  public List<InviteView> listInvites(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.MEMBERSHIP_READ);
    return identities.listInvites(context.organizationId()).stream()
        .map(row -> new InviteView(row.getId(), row.getRole(), row.getExpiresAt(), row.getAcceptedAt(), row.getCreatedAt()))
        .toList();
  }

  public void revokeInvite(String organizationId, String inviteId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.MEMBERSHIP_INVITE);
    if (identities.deleteInvite(context.organizationId(), Ids.requireResourceId(inviteId, "Invalid invite")) == 0) {
      throw ApiException.notFound("Invite");
    }
  }

  public PageResponse<MemberView> listMembers(String organizationId, int page, int pageSize, Optional<String> status) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.CREDENTIAL_MANAGE);
    List<Member> rows = identities.listMembers(context.organizationId(), status.orElse(null), pageSize, (page - 1) * pageSize);
    int total = rows.isEmpty() ? 0 : Optional.ofNullable(rows.getFirst().getTotal()).orElse(0);
    return new PageResponse<>(rows.stream().map(IdentityViews::member).toList(), page, pageSize, total);
  }

  @Transactional
  public MemberView inviteMember(String organizationId, InviteMemberRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.MEMBERSHIP_INVITE);
    MembershipRole invited = MembershipRole.fromWire(Optional.ofNullable(request.role()).orElse("member"));
    if (!Rbac.canManageRole(context.role(), invited)) {
      throw new ApiException("permission_denied", "Role cannot manage the requested membership", 403);
    }
    User user = auth.provisionUser(request.username(), request.password(), request.displayName());
    String id = UUID.randomUUID().toString();
    try {
      identities.insertMembership(id, context.organizationId(), user.getId(), invited.wire(), "active");
    } catch (DuplicateKeyException error) {
      throw ApiException.conflict("membership_exists", "User already belongs to this organization");
    }
    catalog.insertAudit(
        context.organizationId(),
        context.userId(),
        "membership.invite",
        "membership",
        id,
        mapper.createObjectNode().put("userId", user.getId()).put("username", user.getUsername()).put("role", invited.wire()));
    agents.scheduleWakeFor(context.organizationId(), user.getId());
    return identities.findMember(context.organizationId(), id).map(IdentityViews::member).orElseThrow();
  }

  @Transactional
  public MemberView updateMember(String organizationId, String membershipId, UpdateMemberRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.MEMBERSHIP_UPDATE);
    Member target = identities.findMember(
            context.organizationId(), Ids.requireResourceId(membershipId, "Invalid membership"))
        .orElseThrow(() -> ApiException.notFound("Membership"));
    MembershipRole targetRole = MembershipRole.fromWire(target.getRole());
    if (!Rbac.canManageRole(context.role(), targetRole)) {
      throw new ApiException("permission_denied", "Role cannot manage the requested membership", 403);
    }
    Optional.ofNullable(request.role()).ifPresent(role -> {
      if (!Rbac.canManageRole(context.role(), MembershipRole.fromWire(role))) {
        throw new ApiException("permission_denied", "Role cannot manage the requested membership", 403);
      }
    });
    if (target.getUserId().equals(context.userId())
        && request.status() != null
        && !"active".equals(request.status())) {
      throw ApiException.conflict("cannot_disable_self", "Administrators cannot disable their own membership");
    }
    if ("admin".equals(target.getRole())
        && ((request.role() != null && !"admin".equals(request.role()))
            || (request.status() != null && !"active".equals(request.status())))) {
      if (identities.countActiveAdmins(context.organizationId(), target.getId()) < 1) {
        throw ApiException.conflict("last_admin", "The last active organization admin cannot be removed or demoted");
      }
    }
    identities.updateMembership(context.organizationId(), target.getId(), request.role(), request.status());
    return identities.findMember(context.organizationId(), target.getId()).map(IdentityViews::member).orElseThrow();
  }

  @Transactional
  public MemberRemoved removeMember(String organizationId, String membershipId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.MEMBERSHIP_REMOVE);
    Member target = identities.findMember(
            context.organizationId(), Ids.requireResourceId(membershipId, "Invalid membership"))
        .orElseThrow(() -> ApiException.notFound("Membership"));
    if (!Rbac.canManageRole(context.role(), MembershipRole.fromWire(target.getRole()))) {
      throw new ApiException("permission_denied", "Role cannot manage the requested membership", 403);
    }
    if (target.getUserId().equals(context.userId())) {
      throw ApiException.conflict("cannot_remove_self", "Administrators cannot remove their own membership");
    }
    if ("admin".equals(target.getRole())
        && "active".equals(target.getStatus())
        && identities.countActiveAdmins(context.organizationId(), target.getId()) < 1) {
      throw ApiException.conflict("last_admin", "The last active organization admin cannot be removed or demoted");
    }
    identities.deleteMembership(context.organizationId(), target.getId());
    return new MemberRemoved(target.getId(), true);
  }

  public PageResponse<ModelProfileView> listModels(int page, int pageSize) {
    auth.requireSuperAdmin();
    int size = Math.min(Math.max(pageSize, 1), 100);
    int normalizedPage = Math.max(page, 1);
    List<ModelProfile> rows = catalog.listModels(size, (normalizedPage - 1) * size);
    int total = rows.isEmpty() ? 0 : Optional.ofNullable(rows.getFirst().getTotal()).orElse(0);
    return new PageResponse<>(rows.stream().map(CatalogViews::model).toList(), normalizedPage, size, total);
  }

  @Transactional
  @CacheEvict(cacheNames = {"models", "modelList"}, allEntries = true)
  public ModelProfileView createModel(CreateModelRequest request) {
    auth.requireSuperAdmin();
    String userId = access.currentIdentity().userId();
    String credentialId = request.credentialHandleId();
    Instant now = Instant.now();
    if (request.apiKey() != null && !request.apiKey().isBlank()) {
      credentialId = UUID.randomUUID().toString();
      catalog.insertCredential(new CredentialHandle(
          credentialId,
          required(request.name(), "name") + " credential",
          required(request.provider(), "provider"),
          "local:" + credentialId,
          mapper.createObjectNode(),
          vault.encrypt(request.apiKey(), Optional.ofNullable(request.baseUrl())),
          "active",
          userId,
          now,
          now,
          1));
    }
    String id = UUID.randomUUID().toString();
    catalog.insertModel(new ModelProfile(
        id,
        required(request.name(), "name"),
        required(request.provider(), "provider"),
        required(request.model(), "model"),
        credentialId,
        configurationWithContextWindow(request.configuration(), request.contextWindow(), 256_000),
        "active",
        userId,
        now,
        now,
        1));
    return catalog.findModel(id)
        .map(CatalogViews::model)
        .orElseThrow();
  }

  @Transactional
  @CacheEvict(cacheNames = {"models", "modelList"}, allEntries = true)
  public ModelProfileView updateModel(String modelId, UpdateModelRequest request) {
    auth.requireSuperAdmin();
    ModelProfile row = catalog.findModel(modelId)
        .orElseThrow(() -> ApiException.notFound("Model"));
    if (request.status() != null) {
      String status = request.status().trim();
      if (!List.of("active", "disabled").contains(status)) {
        throw ApiException.invalidRequest("status must be active or disabled");
      }
      row.setStatus(status);
    }
    Optional.ofNullable(request.name()).map(String::trim).filter(value -> !value.isBlank()).ifPresent(row::setName);
    Optional.ofNullable(request.provider()).map(String::trim).filter(value -> !value.isBlank()).ifPresent(row::setProvider);
    Optional.ofNullable(request.model()).map(String::trim).filter(value -> !value.isBlank()).ifPresent(row::setModel);
    if (request.configuration() != null || request.contextWindow() != null) {
      row.setConfiguration(configurationWithContextWindow(
          Optional.ofNullable(request.configuration()).orElse(row.getConfiguration()),
          request.contextWindow(),
          row.getConfiguration().path("contextWindow").asInt(256_000)));
    }
    if (request.apiKey() != null && !request.apiKey().isBlank()) {
      String credentialId = UUID.randomUUID().toString();
      Instant now = Instant.now();
      catalog.insertCredential(new CredentialHandle(
          credentialId,
          row.getName() + " credential",
          row.getProvider(),
          "local:" + credentialId,
          mapper.createObjectNode(),
          vault.encrypt(request.apiKey(), Optional.ofNullable(request.baseUrl())),
          "active",
          access.currentIdentity().userId(),
          now,
          now,
          1));
      row.setCredentialHandleId(credentialId);
    }
    catalog.updateModel(row);
    return catalog.findModel(modelId)
        .map(CatalogViews::model)
        .orElseThrow();
  }

  @Transactional
  @CacheEvict(cacheNames = {"models", "modelList"}, allEntries = true)
  public void deleteModel(String modelId) {
    auth.requireSuperAdmin();
    ModelProfile row = catalog.findModel(modelId)
        .orElseThrow(() -> ApiException.notFound("Model"));
    if (catalog.deleteModel(row.getId()) == 0) {
      throw ApiException.notFound("Model");
    }
  }

  public TokenUsageView platformTokenUsage(int requestedDays, String requestedOrganizationId) {
    auth.requireSuperAdmin();
    String organizationId = Optional.ofNullable(requestedOrganizationId)
        .filter(value -> !value.isBlank())
        .map(value -> Ids.requireResourceId(value, "Invalid Organization identifier"))
        .orElse(null);
    return tokenUsage(requestedDays, organizationId, "platform");
  }

  public TokenUsageView organizationTokenUsage(String organizationId, int requestedDays) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.TOKEN_USAGE_READ);
    return tokenUsage(requestedDays, context.organizationId(), "organization");
  }

  private TokenUsageView tokenUsage(int requestedDays, String organizationId, String scope) {
    int days = Math.min(Math.max(requestedDays, 1), 365);
    TokenUsageTotals usage = catalog.tokenUsage(days, organizationId);
    return new TokenUsageView(
        scope,
        organizationId,
        days,
        usage.getInputTokens(),
        usage.getOutputTokens(),
        usage.getTotalTokens(),
        usage.getCacheReadTokens(),
        usage.getCacheWriteTokens(),
        usage.getReasoningTokens(),
        usage.getLlmCalls(),
        Optional.ofNullable(usage.getEstimatedCostUsd()).orElse(java.math.BigDecimal.ZERO),
        catalog.tokenUsageTrend(days, organizationId).stream()
            .map(row -> new TokenUsageTrendView(
                row.getDate(), row.getInputTokens(), row.getOutputTokens(), row.getTotalTokens(), row.getLlmCalls()))
            .toList(),
        "platform".equals(scope)
            ? catalog.tokenUsageByOrganization(days, organizationId).stream().map(AdminService::tokenRank).toList()
            : List.of(),
        catalog.tokenUsageByUser(days, organizationId).stream().map(AdminService::tokenRank).toList(),
        catalog.tokenUsageByModel(days, organizationId).stream().map(AdminService::tokenRank).toList());
  }

  private static TokenUsageRankView tokenRank(com.kross.catalog.entity.TokenUsageRankRow row) {
    return new TokenUsageRankView(
        row.getId(),
        row.getName(),
        row.getSecondary(),
        row.getInputTokens(),
        row.getOutputTokens(),
        row.getTotalTokens(),
        row.getLlmCalls());
  }

  public PageResponse<AuditEventView> listAudit(
      String organizationId, int page, int pageSize, Optional<String> action, Optional<String> resourceType) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AUDIT_READ);
    List<AuditEvent> rows = catalog.listAudit(
        context.organizationId(), action.orElse(null), resourceType.orElse(null), pageSize, (page - 1) * pageSize);
    int total = rows.isEmpty() ? 0 : Optional.ofNullable(rows.getFirst().getTotal()).orElse(0);
    return new PageResponse<>(rows.stream().map(CatalogViews::audit).toList(), page, pageSize, total);
  }

  private static String required(String value, String field) {
    if (value == null || value.isBlank()) {
      throw ApiException.invalidRequest("Missing " + field);
    }
    return value.trim();
  }

  private ObjectNode configurationWithContextWindow(JsonNode source, Integer requested, int fallback) {
    int contextWindow = Optional.ofNullable(requested).orElse(fallback);
    if (contextWindow < 4_096 || contextWindow > 2_000_000) {
      throw ApiException.invalidRequest("contextWindow must be between 4096 and 2000000");
    }
    ObjectNode configuration = source != null && source.isObject()
        ? (ObjectNode) source.deepCopy()
        : mapper.createObjectNode();
    configuration.put("contextWindow", contextWindow);
    return configuration;
  }
}
