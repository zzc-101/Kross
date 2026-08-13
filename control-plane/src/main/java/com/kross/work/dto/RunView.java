package com.kross.work.dto;

import java.time.Instant;

public record RunView(
    String id,
    String organizationId,
    String projectId,
    String taskId,
    int attempt,
    String status,
    String mode,
    Instant queuedAt,
    Instant startedAt,
    Instant finishedAt,
    String createdBy) {}
