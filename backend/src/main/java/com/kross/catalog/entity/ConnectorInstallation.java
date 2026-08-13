package com.kross.catalog.entity;

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
public class ConnectorInstallation {
  private String id;
  private String organizationId;
  private String projectId;
  private String connectorDefinitionId;
  private String displayName;
  private String credentialHandle;
  private JsonNode grantedScopes;
  private String status;
  private String lastErrorCode;
  private String installedBy;
  private Instant createdAt;
  private Instant updatedAt;
  private String connectorName;
  private JsonNode allowedTools;
  private JsonNode requiredScopes;
}
