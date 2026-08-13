package com.kross.controller;

import com.kross.api.ApiHeaders;
import com.kross.api.ItemList;
import com.kross.api.Res;
import com.kross.work.WorkService;
import com.kross.work.dto.CreateProjectRequest;
import com.kross.work.dto.ProjectView;
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
@RequestMapping("/projects")
public class ProjectController {
  private final WorkService work;

  @GetMapping
  public Res<ItemList<ProjectView>> list(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(new ItemList<>(work.listProjects(organizationId)));
  }

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public Res<ProjectView> create(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody CreateProjectRequest request) {
    return Res.ok(work.createProject(organizationId, request));
  }

  @GetMapping("/{projectId}")
  public Res<ProjectView> get(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String projectId) {
    return Res.ok(work.getProject(organizationId, projectId));
  }
}
