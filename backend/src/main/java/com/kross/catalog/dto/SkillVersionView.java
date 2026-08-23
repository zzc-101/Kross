package com.kross.catalog.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

public record SkillVersionView(
    long version,
    String packageSha256,
    long packageSizeBytes,
    JsonNode manifest,
    String changelog,
    boolean active,
    Instant createdAt,
    Instant publishedAt) {}

