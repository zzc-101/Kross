package com.kross.controller.admin;

import com.kross.api.ApiHeaders;
import com.kross.api.PageResponse;
import com.kross.api.Res;
import com.kross.catalog.AdminService;
import com.kross.catalog.dto.AuditEventView;
import com.kross.catalog.dto.CreateModelRequest;
import com.kross.catalog.dto.ModelProfileView;
import com.kross.catalog.dto.UpdateModelRequest;
import com.kross.catalog.dto.TokenUsageView;
import com.kross.identity.AuthLogService;
import com.kross.identity.AuthService;
import com.kross.identity.PlatformService;
import com.kross.identity.SsoService;
import com.kross.identity.dto.AuthLoginEventView;
import com.kross.identity.dto.AssignOrgAdminRequest;
import com.kross.identity.dto.CreateInviteRequest;
import com.kross.identity.dto.CreateOrganizationRequest;
import com.kross.identity.dto.CreateUserRequest;
import com.kross.identity.dto.CreatedInviteView;
import com.kross.identity.dto.DashboardResponse;
import com.kross.identity.dto.InviteMemberRequest;
import com.kross.identity.dto.InviteView;
import com.kross.identity.dto.MemberRemoved;
import com.kross.identity.dto.MemberView;
import com.kross.identity.dto.OrganizationPolicyView;
import com.kross.identity.dto.PlatformOrganizationView;
import com.kross.identity.dto.PlatformSettingsView;
import com.kross.identity.dto.PlatformSsoView;
import com.kross.identity.dto.UpdateMemberRequest;
import com.kross.identity.dto.UpdateOrganizationRequest;
import com.kross.identity.dto.UpdatePlatformRequest;
import com.kross.identity.dto.UpdatePolicyRequest;
import com.kross.identity.dto.UpdateSsoRequest;
import com.kross.identity.dto.UserAccountView;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/admin")
public class AdminController {
  private final AdminService admin;
  private final AuthService auth;
  private final AuthLogService authLogs;
  private final PlatformService platform;
  private final SsoService sso;

  @GetMapping("/platform")
  public Res<PlatformSettingsView> platform() {
    return Res.ok(auth.platform());
  }

  @PatchMapping("/platform")
  public Res<PlatformSettingsView> updatePlatform(@RequestBody UpdatePlatformRequest request) {
    return Res.ok(auth.updatePlatform(request));
  }

  @GetMapping("/platform/sso")
  public Res<PlatformSsoView> sso(HttpServletRequest request) {
    return Res.ok(sso.view(request));
  }

  @PatchMapping("/platform/sso")
  public Res<PlatformSsoView> updateSso(@RequestBody UpdateSsoRequest body, HttpServletRequest request) {
    return Res.ok(sso.update(body, request));
  }

  @GetMapping("/platform/organizations")
  public Res<PageResponse<PlatformOrganizationView>> organizations(
      @RequestParam(defaultValue = "1") int page,
      @RequestParam(defaultValue = "20") int pageSize) {
    return Res.ok(platform.listOrganizations(page, pageSize));
  }

  @PostMapping("/platform/organizations")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<PlatformOrganizationView> createOrganization(@RequestBody CreateOrganizationRequest request) {
    return Res.ok(platform.createOrganization(request));
  }

  @PatchMapping("/platform/organizations/{organizationId}")
  public Res<PlatformOrganizationView> updateOrganization(
      @PathVariable String organizationId,
      @RequestBody UpdateOrganizationRequest request) {
    return Res.ok(platform.updateOrganization(organizationId, request));
  }

  @PostMapping("/platform/organizations/{organizationId}/admins")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<MemberView> assignAdmin(
      @PathVariable String organizationId,
      @RequestBody AssignOrgAdminRequest request) {
    return Res.ok(platform.assignAdmin(organizationId, request));
  }

  @GetMapping("/users")
  public Res<PageResponse<UserAccountView>> users(
      @RequestParam(defaultValue = "1") int page,
      @RequestParam(defaultValue = "20") int pageSize) {
    return Res.ok(auth.listUsers(page, pageSize));
  }

  @PostMapping("/users")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<UserAccountView> createUser(@RequestBody CreateUserRequest request) {
    return Res.ok(auth.createUser(request));
  }

  @GetMapping("/dashboard")
  public Res<DashboardResponse> dashboard(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(admin.dashboard(organizationId));
  }

  @GetMapping("/members")
  public Res<PageResponse<MemberView>> members(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam(defaultValue = "1") int page,
      @RequestParam(defaultValue = "20") int pageSize,
      @RequestParam Optional<String> status) {
    return Res.ok(admin.listMembers(organizationId, page, pageSize, status));
  }

  @PostMapping("/members")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<MemberView> inviteMember(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody InviteMemberRequest request) {
    return Res.ok(admin.inviteMember(organizationId, request));
  }

  @GetMapping("/invites")
  public Res<List<InviteView>> invites(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(admin.listInvites(organizationId));
  }

  @PostMapping("/invites")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<CreatedInviteView> createInvite(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody(required = false) CreateInviteRequest request) {
    return Res.ok(admin.createInvite(
        organizationId, Optional.ofNullable(request).orElse(new CreateInviteRequest(null, null))));
  }

  @DeleteMapping("/invites/{inviteId}")
  public Res<Void> revokeInvite(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String inviteId) {
    admin.revokeInvite(organizationId, inviteId);
    return Res.ok();
  }

  @PatchMapping("/members/{membershipId}")
  public Res<MemberView> updateMember(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String membershipId,
      @RequestBody UpdateMemberRequest request) {
    return Res.ok(admin.updateMember(organizationId, membershipId, request));
  }

  @DeleteMapping("/members/{membershipId}")
  public Res<MemberRemoved> removeMember(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String membershipId) {
    return Res.ok(admin.removeMember(organizationId, membershipId));
  }

  @GetMapping("/approval-policy")
  public Res<OrganizationPolicyView> getPolicy(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(admin.getPolicy(organizationId));
  }

  @PatchMapping("/approval-policy")
  public Res<OrganizationPolicyView> updatePolicy(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody UpdatePolicyRequest request) {
    return Res.ok(admin.updatePolicy(organizationId, request));
  }

  @GetMapping("/auth-logs")
  public Res<PageResponse<AuthLoginEventView>> authLogs(
      @RequestParam(defaultValue = "1") int page,
      @RequestParam(defaultValue = "20") int pageSize,
      @RequestParam Optional<String> eventType,
      @RequestParam Optional<String> outcome) {
    return Res.ok(authLogs.list(page, pageSize, eventType, outcome));
  }

  @GetMapping("/audit-logs")
  public Res<PageResponse<AuditEventView>> auditLogs(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam(defaultValue = "1") int page,
      @RequestParam(defaultValue = "20") int pageSize,
      @RequestParam Optional<String> action,
      @RequestParam Optional<String> resourceType) {
    return Res.ok(admin.listAudit(organizationId, page, pageSize, action, resourceType));
  }

  @GetMapping("/platform/models")
  public Res<PageResponse<ModelProfileView>> models(
      @RequestParam(defaultValue = "1") int page,
      @RequestParam(defaultValue = "20") int pageSize) {
    return Res.ok(admin.listModels(page, pageSize));
  }

  @GetMapping("/platform/token-usage")
  public Res<TokenUsageView> platformTokenUsage(
      @RequestParam(defaultValue = "30") int days,
      @RequestParam(required = false) String organizationId) {
    return Res.ok(admin.platformTokenUsage(days, organizationId));
  }

  @GetMapping("/token-usage")
  public Res<TokenUsageView> organizationTokenUsage(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam(defaultValue = "30") int days) {
    return Res.ok(admin.organizationTokenUsage(organizationId, days));
  }

  @PostMapping("/platform/models")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<ModelProfileView> createModel(@RequestBody CreateModelRequest request) {
    return Res.ok(admin.createModel(request));
  }

  @PatchMapping("/platform/models/{modelId}")
  public Res<ModelProfileView> updateModel(
      @PathVariable String modelId,
      @RequestBody UpdateModelRequest request) {
    return Res.ok(admin.updateModel(modelId, request));
  }

  @DeleteMapping("/platform/models/{modelId}")
  public Res<Void> deleteModel(@PathVariable String modelId) {
    admin.deleteModel(modelId);
    return Res.ok();
  }
}
