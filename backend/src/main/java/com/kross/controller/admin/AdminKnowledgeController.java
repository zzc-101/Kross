package com.kross.controller.admin;

import com.kross.api.PageResponse;
import com.kross.api.Res;
import com.kross.knowledge.KnowledgeService;
import com.kross.knowledge.dto.KnowledgeDocumentView;
import com.kross.knowledge.dto.KnowledgeJobView;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequiredArgsConstructor
@RequestMapping("/admin/knowledge")
public class AdminKnowledgeController {
  private final KnowledgeService knowledge;

  @GetMapping("/documents")
  public Res<PageResponse<KnowledgeDocumentView>> documents(
      @RequestParam(defaultValue = "1") int page,
      @RequestParam(defaultValue = "20") int pageSize) {
    return Res.ok(knowledge.listDocuments(page, pageSize));
  }

  @PostMapping(value = "/documents", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  @ResponseStatus(HttpStatus.CREATED)
  public Res<KnowledgeDocumentView> ingest(
      @RequestPart(value = "title", required = false) String title,
      @RequestPart("file") MultipartFile file) {
    return Res.ok(knowledge.ingest(title, file));
  }

  @PostMapping("/documents/{documentId}/publish")
  public Res<KnowledgeDocumentView> publish(@PathVariable String documentId) {
    return Res.ok(knowledge.publish(documentId));
  }

  @GetMapping("/jobs/{jobId}")
  public Res<KnowledgeJobView> job(@PathVariable String jobId) {
    return Res.ok(knowledge.job(jobId));
  }
}
