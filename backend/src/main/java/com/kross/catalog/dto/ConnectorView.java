package com.kross.catalog.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;
import java.util.List;

public record ConnectorView(
    String id,
    @JsonProperty("organization_id") String organizationId,
    @JsonProperty("project_id") String projectId,
    @JsonProperty("connector_definition_id") String connectorDefinitionId,
    @JsonProperty("display_name") String displayName,
    @JsonProperty("granted_scopes") List<String> grantedScopes,
    String status,
    @JsonProperty("last_error_code") String lastErrorCode,
    @JsonProperty("created_at") Instant createdAt,
    @JsonProperty("updated_at") Instant updatedAt,
    @JsonProperty("connector_name") String connectorName,
    @JsonProperty("allowed_tools") List<String> allowedTools,
    @JsonProperty("required_scopes") List<String> requiredScopes) {}
