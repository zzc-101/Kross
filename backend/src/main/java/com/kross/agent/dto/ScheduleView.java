package com.kross.agent.dto;

import java.time.Instant;

public record ScheduleView(
    String id,
    String name,
    String prompt,
    String skillId,
    String conversationMode,
    String conversationId,
    String timezone,
    String kind,
    String cronExpr,
    Instant runAt,
    Instant nextRunAt,
    Instant lastRunAt,
    String status,
    int consecutiveFailures,
    Instant createdAt,
    Instant updatedAt) {}
