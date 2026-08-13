package com.kross.controller.admin;

import com.kross.api.ApiHeaders;
import com.kross.api.ItemList;
import com.kross.api.PageResponse;
import com.kross.api.Res;
import com.kross.catalog.AdminService;
import com.kross.catalog.dto.AuditEventView;
import com.kross.catalog.dto.ConnectorView;
import com.kross.catalog.dto.CreateModelRequest;
import com.kross.catalog.dto.ModelProfileView;
import com.kross.identity.dto.BootstrapRequest;
import com.kross.identity.dto.BootstrapResponse;
import com.kross.identity.dto.DashboardResponse;
import com.kross.identity.dto.InviteMemberRequest;
import com.kross.identity.dto.MemberRemoved;
import com.kross.identity.dto.MemberView;
import com.kross.identity.dto.OrganizationPolicyView;
import com.kross.identity.dto.UpdateMemberRequest;
import com.kross.identity.dto.UpdatePolicyRequest;
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

  @PostMapping("/bootstrap")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<BootstrapResponse> bootstrap(@RequestBody BootstrapRequest request) {
    return Res.ok(admin.bootstrap(request));
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

  @GetMapping("/connectors")
  public Res<ItemList<ConnectorView>> connectors(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(admin.listConnectors(organizationId));
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

  @GetMapping("/models")
  public Res<PageResponse<ModelProfileView>> models(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam(defaultValue = "1") int page,
      @RequestParam(defaultValue = "20") int pageSize) {
    return Res.ok(admin.listModels(organizationId, page, pageSize));
  }

  @PostMapping("/models")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<ModelProfileView> createModel(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody CreateModelRequest request) {
    return Res.ok(admin.createModel(organizationId, request));
  }
}
