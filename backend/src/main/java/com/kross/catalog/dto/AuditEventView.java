package com.kross.catalog.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

public record AuditEventView(
    String id,
    String actorUserId,
    String action,
    String resourceType,
    String resourceId,
    JsonNode payload,
    Instant occurredAt) {}
