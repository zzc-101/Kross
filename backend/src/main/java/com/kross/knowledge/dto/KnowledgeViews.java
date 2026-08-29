package com.kross.knowledge.dto;

import com.kross.knowledge.entity.KnowledgeDocument;
import com.kross.knowledge.entity.KnowledgeJob;
import java.util.Optional;

public final class KnowledgeViews {
  private KnowledgeViews() {}

  public static KnowledgeDocumentView document(KnowledgeDocument row) {
    return new KnowledgeDocumentView(
        row.getId(),
        row.getSpaceId(),
        row.getTitle(),
        row.getFilename(),
        row.getMime(),
        row.getStatus(),
        row.getCreatedBy(),
        row.getCreatedAt(),
        row.getPublishedAt(),
        row.getErrorMessage());
  }

  public static KnowledgeJobView job(KnowledgeJob row) {
    return new KnowledgeJobView(
        row.getId(),
        row.getDocumentId(),
        row.getKind(),
        row.getStatus(),
        row.getErrorMessage(),
        row.getCreatedAt(),
        row.getUpdatedAt());
  }

  public static String titleOf(String title, String filename) {
    return Optional.ofNullable(title).map(String::trim).filter(value -> !value.isBlank())
        .or(() -> Optional.ofNullable(filename).map(String::trim).filter(value -> !value.isBlank()))
        .orElse("未命名文档");
  }
}
