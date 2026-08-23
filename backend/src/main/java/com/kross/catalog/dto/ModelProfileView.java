package com.kross.catalog.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

@JsonInclude(JsonInclude.Include.ALWAYS)
public record ModelProfileView(
    String id,
    String name,
    String provider,
    String model,
    int contextWindow,
    String credentialHandleId,
    JsonNode configuration,
    String status,
    Instant createdAt,
    Instant updatedAt) {}
