package com.kross.controller;

import com.kross.api.ApiHeaders;
import com.kross.api.ItemList;
import com.kross.api.Res;
import com.kross.work.WorkService;
import com.kross.work.dto.CompleteSourceRequest;
import com.kross.work.dto.CreateExternalSourceRequest;
import com.kross.work.dto.CreateInlineSourceRequest;
import com.kross.work.dto.CreateUploadSourceRequest;
import com.kross.work.dto.SourceUploadView;
import com.kross.work.dto.SourceView;
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
@RequestMapping("/sources")
public class SourceController {
  private final WorkService work;

  @GetMapping
  public Res<ItemList<SourceView>> list(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam String projectId) {
    return Res.ok(new ItemList<>(work.listSources(organizationId, projectId)));
  }

  @PostMapping("/uploads")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<SourceUploadView> createUpload(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam String projectId,
      @RequestBody CreateUploadSourceRequest request) {
    return Res.ok(work.createUpload(organizationId, projectId, request));
  }

  @PostMapping("/inline")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<SourceView> createInline(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam String projectId,
      @RequestBody CreateInlineSourceRequest request) {
    return Res.ok(work.createInline(organizationId, projectId, request));
  }

  @PostMapping("/external")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<SourceView> createExternal(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam String projectId,
      @RequestBody CreateExternalSourceRequest request) {
    return Res.ok(work.createExternal(organizationId, projectId, request));
  }

  @PostMapping("/{sourceId}/complete")
  public Res<SourceView> complete(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String sourceId,
      @RequestBody CompleteSourceRequest request) {
    return Res.ok(work.completeSource(organizationId, sourceId, request));
  }
}
