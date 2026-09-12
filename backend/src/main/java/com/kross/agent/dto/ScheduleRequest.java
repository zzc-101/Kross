package com.kross.agent.dto;

public record ScheduleRequest(
    String name,
    String prompt,
    String skillId,
    String conversationMode,
    String conversationId,
    String timezone,
    String kind,
    String cronExpr,
    String runAt,
    String status) {}
