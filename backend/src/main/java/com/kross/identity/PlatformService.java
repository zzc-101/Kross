package com.kross.identity;

import com.kross.agent.AgentService;
import com.kross.api.ApiException;
import com.kross.api.PageResponse;
import com.kross.identity.dto.AssignOrgAdminRequest;
import com.kross.identity.dto.CreateOrganizationRequest;
import com.kross.identity.dto.IdentityViews;
import com.kross.identity.dto.MemberView;
import com.kross.identity.dto.PlatformOrganizationView;
import com.kross.identity.dto.UpdateOrganizationRequest;
import com.kross.identity.entity.Membership;
import com.kross.identity.entity.Organization;
import com.kross.identity.entity.OrganizationListRow;
import com.kross.identity.entity.User;
import com.kross.support.Ids;
import com.kross.support.Policies;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class PlatformService {
  private final AuthService auth;
  private final IdentityMapper identities;
  private final AgentService agents;

  public PageResponse<PlatformOrganizationView> listOrganizations(int page, int pageSize) {
    auth.requireSuperAdmin();
    int size = Math.min(Math.max(pageSize, 1), 100);
    int offset = (Math.max(page, 1) - 1) * size;
    List<OrganizationListRow> rows = identities.listOrganizations(size, offset);
    int total = rows.isEmpty() ? 0 : Optional.ofNullable(rows.getFirst().getTotal()).orElse(0);
    return new PageResponse<>(
        rows.stream().map(IdentityViews::platformOrganization).toList(),
        Math.max(page, 1),
        size,
        total);
  }

  @Transactional
  public PlatformOrganizationView createOrganization(CreateOrganizationRequest request) {
    auth.requireSuperAdmin();
    String name = required(request.name(), "name");
    String slug = Ids.requireSlug(required(request.slug(), "slug"));
    String timezone = Optional.ofNullable(request.defaultTimezone()).filter(value -> !value.isBlank()).orElse("UTC");
    String organizationId = UUID.randomUUID().toString();
    try {
      identities.insertOrganization(organizationId, slug, name, timezone, Policies.defaultApprovalPolicy());
    } catch (DuplicateKeyException error) {
      throw ApiException.conflict("organization_exists", "Organization slug already exists");
    }
    User admin = auth.provisionUser(request.adminUsername(), request.adminPassword(), request.adminDisplayName());
    addAdmin(organizationId, admin);
    agents.scheduleWakeFor(organizationId, admin.getId());
    return identities.findOrganizationRow(organizationId).map(IdentityViews::platformOrganization)
        .orElseGet(() -> new PlatformOrganizationView(organizationId, slug, name, "active", 1, 1, java.time.Instant.now()));
  }

  @Transactional
  public PlatformOrganizationView updateOrganization(String organizationId, UpdateOrganizationRequest request) {
    auth.requireSuperAdmin();
    Organization organization = identities.findOrganization(Ids.requireResourceId(organizationId, "Invalid Organization identifier"))
        .orElseThrow(() -> ApiException.notFound("Organization"));
    Optional.ofNullable(request.status()).ifPresent(status -> {
      if (!List.of("active", "suspended").contains(status)) {
        throw ApiException.invalidRequest("status must be active or suspended");
      }
    });
    String name = Optional.ofNullable(request.name()).map(String::trim).filter(value -> !value.isBlank()).orElse(null);
    identities.updateOrganization(organization.getId(), name, request.status());
    return identities.findOrganizationRow(organization.getId()).map(IdentityViews::platformOrganization)
        .orElseThrow(() -> ApiException.notFound("Organization"));
  }

  @Transactional
  public MemberView assignAdmin(String organizationId, AssignOrgAdminRequest request) {
    auth.requireSuperAdmin();
    Organization organization = identities.findOrganization(Ids.requireResourceId(organizationId, "Invalid Organization identifier"))
        .orElseThrow(() -> ApiException.notFound("Organization"));
    User admin = auth.provisionUser(request.username(), request.password(), request.displayName());
    addAdmin(organization.getId(), admin);
    agents.scheduleWakeFor(organization.getId(), admin.getId());
    Membership membership = identities.findMembershipByUser(organization.getId(), admin.getId())
        .orElseThrow(() -> ApiException.notFound("Membership"));
    return identities.findMember(organization.getId(), membership.getId()).map(IdentityViews::member)
        .orElseThrow(() -> ApiException.notFound("Membership"));
  }

  private void addAdmin(String organizationId, User admin) {
    Optional<Membership> existing = identities.findMembershipByUser(organizationId, admin.getId());
    if (existing.isPresent()) {
      identities.updateMembership(organizationId, existing.get().getId(), "admin", "active");
      return;
    }
    identities.insertMembership(UUID.randomUUID().toString(), organizationId, admin.getId(), "admin", "active");
  }

  private static String required(String value, String field) {
    if (value == null || value.isBlank()) {
      throw ApiException.invalidRequest("Missing " + field);
    }
    return value.trim();
  }
}
