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
    String content,
    long revision,
    String status,
    int installCount,
    Instant createdAt,
    Instant updatedAt) {}
