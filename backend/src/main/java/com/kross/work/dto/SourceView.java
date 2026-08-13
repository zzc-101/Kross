package com.kross.work.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

public record SourceView(
    String id,
    @JsonProperty("organization_id") String organizationId,
    @JsonProperty("project_id") String projectId,
    @JsonProperty("task_id") String taskId,
    String kind,
    String scope,
    String status,
    @JsonProperty("display_name") String displayName,
    @JsonProperty("mime_type") String mimeType,
    @JsonProperty("size_bytes") Long sizeBytes,
    String sha256,
    @JsonProperty("blob_key") String blobKey,
    @JsonProperty("external_locator") String externalLocator,
    JsonNode origin,
    @JsonProperty("previous_source_id") String previousSourceId,
    JsonNode metadata,
    @JsonProperty("created_by") String createdBy,
    @JsonProperty("created_at") Instant createdAt) {}
