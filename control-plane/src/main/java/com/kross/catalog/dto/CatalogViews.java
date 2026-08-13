package com.kross.catalog.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.kross.catalog.entity.AuditEvent;
import com.kross.catalog.entity.ConnectorInstallation;
import com.kross.catalog.entity.ModelProfile;
import java.util.ArrayList;
import java.util.List;

public final class CatalogViews {
  private CatalogViews() {}

  public static ModelProfileView model(ModelProfile row) {
    return new ModelProfileView(
        row.getId(),
        row.getName(),
        row.getProvider(),
        row.getModel(),
        row.getCredentialHandleId(),
        row.getConfiguration(),
        row.getStatus(),
        row.getCreatedAt(),
        row.getUpdatedAt());
  }

  public static AuditEventView audit(AuditEvent row) {
    return new AuditEventView(
        row.getId(),
        row.getActorUserId(),
        row.getAction(),
        row.getResourceType(),
        row.getResourceId(),
        row.getPayload(),
        row.getOccurredAt());
  }

  public static ConnectorView connector(ConnectorInstallation row) {
    return new ConnectorView(
        row.getId(),
        row.getOrganizationId(),
        row.getProjectId(),
        row.getConnectorDefinitionId(),
        row.getDisplayName(),
        stringList(row.getGrantedScopes()),
        row.getStatus(),
        row.getLastErrorCode(),
        row.getCreatedAt(),
        row.getUpdatedAt(),
        row.getConnectorName(),
        stringList(row.getAllowedTools()),
        stringList(row.getRequiredScopes()));
  }

  private static List<String> stringList(JsonNode node) {
    if (node == null || !node.isArray()) {
      return List.of();
    }
    List<String> values = new ArrayList<>();
    node.forEach(item -> values.add(item.asText()));
    return List.copyOf(values);
  }
}
