package com.kross.catalog.dto;

import java.time.Instant;

public record OrganizationSkillView(
    String id,
    String name,
    String description,
    String category,
    String icon,
    String launchMode,
    String starterPrompt,
    long revision,
    String status,
    boolean installed,
    Instant installedAt) {}
