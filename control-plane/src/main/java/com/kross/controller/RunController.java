package com.kross.controller;

import com.kross.api.ApiHeaders;
import com.kross.api.Res;
import com.kross.work.WorkService;
import com.kross.work.dto.CreateRunRequest;
import com.kross.work.dto.RunView;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/runs")
public class RunController {
  private final WorkService work;

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public Res<RunView> create(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestHeader(value = ApiHeaders.IDEMPOTENCY_KEY, required = false) String idempotencyKey,
      @RequestBody CreateRunRequest request) {
    return Res.ok(work.createRun(organizationId, request.taskId(), request, idempotencyKey));
  }

  @GetMapping("/{runId}")
  public Res<RunView> get(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String runId) {
    return Res.ok(work.getRun(organizationId, runId));
  }

  @PostMapping("/{runId}/cancel")
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Res<RunView> cancel(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String runId) {
    return Res.ok(work.cancelRun(organizationId, runId));
  }
}
