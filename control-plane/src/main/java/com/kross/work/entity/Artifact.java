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
public class Artifact {
  private String id;
  private String organizationId;
  private String projectId;
  private String taskId;
  private String runId;
  private String kind;
  private String status;
  private String displayName;
  private String fileName;
  private String mimeType;
  private Long sizeBytes;
  private String sha256;
  private String blobKey;
  private String previousArtifactId;
  private JsonNode metadata;
  private Integer generation;
  private String reserveIdempotencyKey;
  private String uploadBlobKey;
  private Instant readyAt;
  private Instant createdAt;
}
