package com.kross.catalog.dto;

import java.math.BigDecimal;

public record TokenUsageView(
    int days,
    long inputTokens,
    long outputTokens,
    long totalTokens,
    long cacheReadTokens,
    long cacheWriteTokens,
    long reasoningTokens,
    long llmCalls,
    BigDecimal estimatedCostUsd) {}
