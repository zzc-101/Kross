package com.kross.catalog.dto;

import java.time.Instant;

public record PlatformSkillView(
    String id,
    String name,
    String description,
    String category,
    String icon,
    String launchMode,
    String starterPrompt,
    long revision,
    long latestVersion,
    int versionCount,
    String packageSha256,
    long packageSizeBytes,
    String status,
    int installCount,
    Instant createdAt,
    Instant updatedAt) {}
