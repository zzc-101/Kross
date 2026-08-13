package com.kross.controller;

import com.kross.api.ApiHeaders;
import com.kross.api.ItemList;
import com.kross.api.Res;
import com.kross.work.WorkService;
import com.kross.work.dto.ArtifactView;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/artifacts")
public class ArtifactController {
  private final WorkService work;

  @GetMapping
  public Res<ItemList<ArtifactView>> list(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam String taskId) {
    return Res.ok(new ItemList<>(work.listArtifacts(organizationId, taskId)));
  }

  @GetMapping("/{artifactId}")
  public Res<ArtifactView> get(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String artifactId) {
    return Res.ok(work.getArtifact(organizationId, artifactId));
  }

  @GetMapping("/{artifactId}/content")
  public ResponseEntity<Void> content(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String artifactId) {
    return ResponseEntity.status(HttpStatus.FOUND)
        .header(HttpHeaders.LOCATION, work.artifactContentUrl(organizationId, artifactId))
        .header(HttpHeaders.CACHE_CONTROL, "private, no-store")
        .build();
  }
}
