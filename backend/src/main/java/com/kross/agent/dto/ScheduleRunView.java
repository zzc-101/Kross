package com.kross.agent.dto;

import java.time.Instant;

public record ScheduleRunView(
    String id,
    String scheduleId,
    String conversationId,
    String userMessageId,
    Instant dueAt,
    Instant claimedAt,
    String status,
    String error) {}
