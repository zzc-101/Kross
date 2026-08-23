package com.kross.catalog.dto;

public record TokenUsageTrendView(
    String date,
    long inputTokens,
    long outputTokens,
    long totalTokens,
    long llmCalls) {}
