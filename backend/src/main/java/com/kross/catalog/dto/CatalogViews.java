package com.kross.catalog.dto;

import com.kross.catalog.entity.AuditEvent;
import com.kross.catalog.entity.ModelProfile;

public final class CatalogViews {
  private CatalogViews() {}

  public static ModelProfileView model(ModelProfile row) {
    return new ModelProfileView(
        row.getId(),
        row.getName(),
        row.getProvider(),
        row.getModel(),
        row.getConfiguration().path("contextWindow").asInt(256_000),
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
}
