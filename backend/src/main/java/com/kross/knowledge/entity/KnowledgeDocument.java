package com.kross.knowledge.entity;

import java.time.Instant;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
public class KnowledgeDocument {
  private String id;
  private String spaceId;
  private String title;
  private String filename;
  private String mime;
  private String status;
  private String sourceKey;
  private String createdBy;
  private Instant createdAt;
  private Instant publishedAt;
  private String errorMessage;
}
