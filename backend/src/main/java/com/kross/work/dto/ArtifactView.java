package com.kross.work.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

public record ArtifactView(
    String id,
    @JsonProperty("organization_id") String organizationId,
    @JsonProperty("project_id") String projectId,
    @JsonProperty("task_id") String taskId,
    @JsonProperty("run_id") String runId,
    String kind,
    String status,
    @JsonProperty("display_name") String displayName,
    @JsonProperty("file_name") String fileName,
    @JsonProperty("mime_type") String mimeType,
    @JsonProperty("size_bytes") Long sizeBytes,
    String sha256,
    @JsonProperty("blob_key") String blobKey,
    @JsonProperty("previous_artifact_id") String previousArtifactId,
    JsonNode metadata,
    Integer generation,
    @JsonProperty("created_at") Instant createdAt,
    @JsonProperty("ready_at") Instant readyAt) {}
