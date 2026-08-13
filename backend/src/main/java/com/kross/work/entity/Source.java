package com.kross.work.entity;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class Source {
  private String id;
  private String organizationId;
  private String projectId;
  private String taskId;
  private String kind;
  private String scope;
  private String status;
  private String displayName;
  private String mimeType;
  private Long sizeBytes;
  private String sha256;
  private String blobKey;
  private String externalLocator;
  private JsonNode origin;
  private String previousSourceId;
  private JsonNode metadata;
  private String createdBy;
  private Instant createdAt;
}
