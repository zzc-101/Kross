package com.kross.controller;

import com.kross.api.ApiHeaders;
import com.kross.api.Res;
import com.kross.knowledge.KnowledgeService;
import com.kross.knowledge.dto.KnowledgeSearchRequest;
import com.kross.knowledge.dto.KnowledgeSearchView;
import com.kross.knowledge.dto.KnowledgeStatusView;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/knowledge")
public class KnowledgeController {
  private final KnowledgeService knowledge;

  @GetMapping("/status")
  public Res<KnowledgeStatusView> status(@RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(knowledge.status(organizationId));
  }

  @PostMapping("/search")
  public Res<KnowledgeSearchView> search(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody KnowledgeSearchRequest request) {
    return Res.ok(knowledge.search(organizationId, request));
  }
}
