package com.kross.controller;

import com.kross.api.ApiHeaders;
import com.kross.api.ItemList;
import com.kross.api.Res;
import com.kross.execution.ApprovalService;
import com.kross.execution.dto.ApprovalView;
import com.kross.execution.dto.DecideApprovalRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/approvals")
public class ApprovalController {
  private final ApprovalService approvals;

  @GetMapping
  public Res<ItemList<ApprovalView>> list(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(new ItemList<>(approvals.listPending(organizationId)));
  }

  @PostMapping("/{approvalId}/decision")
  public Res<ApprovalView> decide(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestHeader(value = ApiHeaders.IDEMPOTENCY_KEY, required = false) String idempotencyKey,
      @PathVariable String approvalId,
      @RequestBody DecideApprovalRequest request) {
    return Res.ok(approvals.decide(organizationId, approvalId, request, idempotencyKey));
  }
}
