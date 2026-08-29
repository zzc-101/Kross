package com.kross.knowledge.entity;

import java.time.Instant;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
public class KnowledgeJob {
  private String id;
  private String documentId;
  private String kind;
  private String status;
  private String errorMessage;
  private Instant createdAt;
  private Instant updatedAt;
}
