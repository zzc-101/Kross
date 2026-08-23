package com.kross.catalog.dto;

public record TokenUsageRankView(
    String id,
    String name,
    String secondary,
    long inputTokens,
    long outputTokens,
    long totalTokens,
    long llmCalls) {}
