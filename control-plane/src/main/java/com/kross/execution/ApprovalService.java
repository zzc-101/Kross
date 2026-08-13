package com.kross.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.kross.api.ApiException;
import com.kross.execution.dto.ApprovalView;
import com.kross.execution.dto.DecideApprovalRequest;
import com.kross.execution.entity.Approval;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import com.kross.identity.Rbac;
import com.kross.support.Ids;
import com.kross.support.Jsons;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class ApprovalService {
  private final OrganizationAccess access;
  private final ExecutionMapper execution;
  private final ObjectMapper mapper;

  public List<ApprovalView> listPending(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.APPROVAL_READ);
    return execution.listPendingApprovals(context.organizationId()).stream()
        .map(ApprovalService::view)
        .toList();
  }

  @Transactional
  public ApprovalView decide(String organizationId, String approvalId, DecideApprovalRequest request, String key) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.APPROVAL_DECIDE);
    String parsedId = Ids.requireResourceId(approvalId, "Invalid Approval identifier");
    String decision = Optional.ofNullable(request)
        .map(DecideApprovalRequest::decision)
        .map(String::trim)
        .filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("decision is required"));
    if (!"approved".equals(decision) && !"rejected".equals(decision)) {
      throw ApiException.invalidRequest("decision must be approved or rejected");
    }
    String idempotencyKey = Optional.ofNullable(key)
        .map(String::trim)
        .filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("Idempotency-Key is required"));
    Approval row = execution.lockApproval(context.organizationId(), parsedId)
        .orElseThrow(() -> ApiException.notFound("Approval"));
    if (idempotencyKey.equals(row.getDecisionIdempotencyKey()) && decision.equals(row.getStatus())) {
      return view(row);
    }
    if (!"pending".equals(row.getStatus())) {
      throw ApiException.conflict("approval_already_decided", "Approval is no longer pending");
    }
    if (row.getExpiresAt() != null && !row.getExpiresAt().isAfter(Instant.now())) {
      execution.expireApproval(context.organizationId(), parsedId);
      throw ApiException.conflict("approval_expired", "Approval has expired");
    }
    if (!canDecide(context, row)) {
      throw new ApiException("approval_forbidden", "Membership cannot decide this Approval", 403);
    }
    row.setStatus(decision);
    row.setDecidedBy(context.userId());
    row.setDecisionReason(Optional.ofNullable(request.reason()).map(String::trim).filter(value -> !value.isBlank()).orElse(null));
    row.setDecisionIdempotencyKey(idempotencyKey);
    if (execution.decideApproval(row) != 1) {
      throw ApiException.conflict("approval_decision_raced", "Approval decision raced");
    }
    execution.requeueRunAfterApproval(context.organizationId(), row.getRunId());
    execution.releaseLeaseAfterApproval(context.organizationId(), row.getRunId());
    ObjectNode audit = mapper.createObjectNode();
    audit.put("decision", decision);
    audit.put("runId", row.getRunId());
    Optional.ofNullable(row.getRequestHash()).ifPresent(value -> audit.put("requestHash", value));
    execution.insertAudit(context.organizationId(), context.userId(), "approval.decide", "approval", parsedId, audit);
    ObjectNode payload = mapper.createObjectNode();
    payload.put("approvalId", parsedId);
    payload.put("status", decision);
    payload.put("decidedBy", context.userId());
    execution.insertApprovalDecidedEvent(
        UUID.randomUUID().toString(),
        context.organizationId(),
        row.getProjectId(),
        row.getTaskId(),
        row.getRunId(),
        payload);
    return view(execution.lockApproval(context.organizationId(), parsedId)
        .orElseThrow(() -> ApiException.notFound("Approval")));
  }

  private static boolean canDecide(OrganizationContext context, Approval row) {
    String risk = Optional.ofNullable(row.getRiskLevel()).orElse("");
    boolean highRisk = "high".equals(risk) || "critical".equals(risk);
    if (!highRisk) {
      return true;
    }
    var policy = Jsons.objectOrEmpty(row.getPermissionPolicy());
    var approvalPolicy = Jsons.objectOrEmpty(
        policy.has("approvalPolicy") ? policy.get("approvalPolicy") : policy.get("approval_policy"));
    return Rbac.canDecideHighRisk(
        context.role(),
        row.getScope(),
        approvalPolicy.path("allowAdminOrganizationHighRiskApproval").asBoolean(false),
        approvalPolicy.path("allowMemberHighRiskApproval").asBoolean(false));
  }

  private static ApprovalView view(Approval row) {
    return new ApprovalView(
        row.getId(),
        row.getOrganizationId(),
        row.getProjectId(),
        row.getTaskId(),
        row.getRunId(),
        row.getKind(),
        row.getScope(),
        row.getRiskLevel(),
        row.getActionPreview(),
        row.getStatus(),
        row.getRequestedAt(),
        row.getExpiresAt(),
        row.getDecidedAt(),
        row.getDecidedBy(),
        row.getDecisionIdempotencyKey());
  }
}
