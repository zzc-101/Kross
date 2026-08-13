package com.kross.work.dto;

import java.time.Instant;
import java.util.List;

public record TaskView(
    String id,
    String organizationId,
    String projectId,
    String type,
    String title,
    String objective,
    List<String> constraints,
    List<String> acceptanceCriteria,
    String status,
    String latestRunId,
    String createdBy,
    Instant createdAt,
    Instant updatedAt) {}
