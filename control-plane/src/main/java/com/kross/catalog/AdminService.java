package com.kross.catalog;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.api.ApiException;
import com.kross.api.PageResponse;
import com.kross.catalog.dto.AuditEventView;
import com.kross.catalog.dto.CatalogViews;
import com.kross.catalog.dto.CreateModelRequest;
import com.kross.catalog.dto.ModelProfileView;
import com.kross.catalog.dto.UpdateModelRequest;
import com.kross.catalog.entity.AuditEvent;
import com.kross.catalog.entity.CredentialHandle;
import com.kross.catalog.entity.ModelProfile;
import com.kross.config.KrossProperties;
import com.kross.identity.Identity;
import com.kross.identity.IdentityMapper;
import com.kross.identity.MembershipRole;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import com.kross.identity.Rbac;
import com.kross.identity.dto.BootstrapRequest;
import com.kross.identity.dto.BootstrapResponse;
import com.kross.identity.dto.DashboardResponse;
import com.kross.identity.dto.IdentityViews;
import com.kross.identity.dto.InviteMemberRequest;
import com.kross.identity.dto.MemberRemoved;
import com.kross.identity.dto.MemberView;
import com.kross.identity.dto.OrganizationPolicyView;
import com.kross.identity.dto.OrganizationSummary;
import com.kross.identity.dto.OwnerMembershipView;
import com.kross.identity.dto.UpdateMemberRequest;
import com.kross.identity.dto.UpdatePolicyRequest;
import com.kross.identity.entity.Member;
import com.kross.support.Ids;
import com.kross.support.Policies;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class AdminService {
  private final KrossProperties properties;
  private final OrganizationAccess access;
  private final IdentityMapper identities;
  private final CatalogMapper catalog;
  private final CredentialVault vault;
  private final ObjectMapper mapper;

  @Transactional
  public BootstrapResponse bootstrap(BootstrapRequest request) {
    if (!properties.isDevIdentityEnabled()) {
      throw new ApiException("bootstrap_disabled", "Organization bootstrap is disabled", 403);
    }
    Identity identity = access.currentIdentity();
    if (identities.countUsersWithMembership(identity.userId()) > 0 || identities.countOrganizations() > 0) {
      throw ApiException.conflict("bootstrap_not_available", "An organization already exists");
    }
    String organizationId = Optional.ofNullable(request.organizationId()).filter(value -> !value.isBlank())
        .orElse(UUID.randomUUID().toString());
    String slug = Ids.requireSlug(required(request.slug(), "slug"));
    String name = required(request.name(), "name");
    String timezone = Optional.ofNullable(request.defaultTimezone()).filter(value -> !value.isBlank()).orElse("UTC");
    identities.upsertUser(identity.userId(), identity.displayName());
    identities.insertOrganization(organizationId, slug, name, timezone, Policies.defaultApprovalPolicy());
    String membershipId = UUID.randomUUID().toString();
    identities.insertMembership(membershipId, organizationId, identity.userId(), "owner", "active");
    catalog.insertAudit(
        organizationId,
        identity.userId(),
        "organization.bootstrap",
        "organization",
        organizationId,
        mapper.createObjectNode().put("slug", slug).put("name", name));
    return new BootstrapResponse(
        new OrganizationSummary(organizationId, slug, name, timezone),
        new OwnerMembershipView(membershipId, identity.userId(), "owner", "active"));
  }

  public DashboardResponse dashboard(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AUDIT_READ);
    return new DashboardResponse(IdentityViews.counts(identities.dashboardCounts(context.organizationId())));
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
    String userId = Ids.requireResourceId(required(request.userId(), "userId"), "Invalid user");
    identities.upsertUser(userId, required(request.displayName(), "displayName"));
    String id = UUID.randomUUID().toString();
    try {
      identities.insertMembership(id, context.organizationId(), userId, invited.wire(), "invited");
    } catch (DuplicateKeyException error) {
      throw ApiException.conflict("membership_exists", "User already belongs to this organization");
    }
    catalog.insertAudit(
        context.organizationId(),
        context.userId(),
        "membership.invite",
        "membership",
        id,
        mapper.createObjectNode().put("userId", userId).put("role", invited.wire()));
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
    if ("owner".equals(target.getRole())
        && ((request.role() != null && !"owner".equals(request.role()))
            || (request.status() != null && !"active".equals(request.status())))) {
      if (identities.countActiveOwners(context.organizationId(), target.getId()) < 1) {
        throw ApiException.conflict("last_owner", "The last active owner cannot be removed or demoted");
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
    if ("owner".equals(target.getRole())
        && "active".equals(target.getStatus())
        && identities.countActiveOwners(context.organizationId(), target.getId()) < 1) {
      throw ApiException.conflict("last_owner", "The last active owner cannot be removed or demoted");
    }
    identities.deleteMembership(context.organizationId(), target.getId());
    return new MemberRemoved(target.getId(), true);
  }

  public OrganizationPolicyView getPolicy(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.CREDENTIAL_MANAGE);
    return IdentityViews.policy(identities.findOrganization(context.organizationId())
        .orElseThrow(() -> ApiException.notFound("Organization")));
  }

  @Transactional
  public OrganizationPolicyView updatePolicy(String organizationId, UpdatePolicyRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.CREDENTIAL_MANAGE);
    boolean setRetention = request.dataRetentionDays() != null;
    Integer retentionDays = !setRetention || request.dataRetentionDays().isNull()
        ? null
        : request.dataRetentionDays().asInt();
    identities.updatePolicy(
        context.organizationId(),
        request.defaultTimezone(),
        setRetention,
        retentionDays,
        request.approvalPolicy());
    return getPolicy(organizationId);
  }

  public PageResponse<ModelProfileView> listModels(String organizationId, int page, int pageSize) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.MODEL_PROFILE_MANAGE);
    List<ModelProfile> rows = catalog.listModels(context.organizationId(), pageSize, (page - 1) * pageSize);
    int total = rows.isEmpty() ? 0 : Optional.ofNullable(rows.getFirst().getTotal()).orElse(0);
    return new PageResponse<>(rows.stream().map(CatalogViews::model).toList(), page, pageSize, total);
  }

  @Transactional
  public ModelProfileView createModel(String organizationId, CreateModelRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.MODEL_PROFILE_MANAGE);
    String credentialId = request.credentialHandleId();
    Instant now = Instant.now();
    if (request.apiKey() != null && !request.apiKey().isBlank()) {
      credentialId = UUID.randomUUID().toString();
      catalog.insertCredential(new CredentialHandle(
          credentialId,
          context.organizationId(),
          required(request.name(), "name") + " credential",
          required(request.provider(), "provider"),
          "local:" + credentialId,
          mapper.createObjectNode(),
          vault.encrypt(request.apiKey(), Optional.ofNullable(request.baseUrl())),
          "active",
          context.userId(),
          now,
          now,
          1));
    }
    String id = UUID.randomUUID().toString();
    catalog.insertModel(new ModelProfile(
        id,
        context.organizationId(),
        required(request.name(), "name"),
        required(request.provider(), "provider"),
        required(request.model(), "model"),
        credentialId,
        Optional.ofNullable(request.configuration()).orElseGet(mapper::createObjectNode),
        "active",
        context.userId(),
        now,
        now,
        1));
    return catalog.listModels(context.organizationId(), 1, 0).stream()
        .filter(row -> id.equals(row.getId()))
        .findFirst()
        .map(CatalogViews::model)
        .orElseThrow();
  }

  @Transactional
  public ModelProfileView updateModel(String organizationId, String modelId, UpdateModelRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.MODEL_PROFILE_MANAGE);
    ModelProfile row = catalog.findModel(context.organizationId(), modelId)
        .orElseThrow(() -> ApiException.notFound("Model"));
    String status = Optional.ofNullable(request.status()).orElse("").trim();
    if (!List.of("active", "disabled").contains(status)) {
      throw ApiException.invalidRequest("status must be active or disabled");
    }
    row.setStatus(status);
    catalog.updateModel(row);
    return catalog.findModel(context.organizationId(), modelId)
        .map(CatalogViews::model)
        .orElseThrow();
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
}
