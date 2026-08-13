package com.kross.controller;

import com.kross.api.ApiHeaders;
import com.kross.api.ItemList;
import com.kross.api.Res;
import com.kross.work.WorkService;
import com.kross.work.dto.AppendMessageRequest;
import com.kross.work.dto.CreateTaskRequest;
import com.kross.work.dto.TaskMessageView;
import com.kross.work.dto.TaskView;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
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
@RequestMapping("/tasks")
public class TaskController {
  private final WorkService work;

  @GetMapping
  public Res<ItemList<TaskView>> list(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam String projectId) {
    return Res.ok(new ItemList<>(work.listTasks(organizationId, projectId)));
  }

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public Res<TaskView> create(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestHeader(value = ApiHeaders.IDEMPOTENCY_KEY, required = false) String idempotencyKey,
      @RequestBody CreateTaskRequest request) {
    return Res.ok(work.createTask(organizationId, request, idempotencyKey));
  }

  @GetMapping("/{taskId}")
  public Res<TaskView> get(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String taskId) {
    return Res.ok(work.getTask(organizationId, taskId));
  }

  @GetMapping("/{taskId}/messages")
  public Res<ItemList<TaskMessageView>> listMessages(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String taskId) {
    return Res.ok(new ItemList<>(work.listMessages(organizationId, taskId)));
  }

  @PostMapping("/{taskId}/messages")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<TaskMessageView> appendMessage(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestHeader(value = ApiHeaders.IDEMPOTENCY_KEY, required = false) String idempotencyKey,
      @PathVariable String taskId,
      @RequestBody AppendMessageRequest request) {
    return Res.ok(work.appendMessage(organizationId, taskId, request, idempotencyKey));
  }
}
