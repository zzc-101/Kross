package com.kross.work.dto;

import java.time.Instant;

public record ProjectView(
    String id,
    String organizationId,
    String kind,
    String name,
    String description,
    String status,
    String createdBy,
    Instant createdAt,
    Instant updatedAt) {}
