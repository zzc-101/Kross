package com.kross.catalog.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.math.BigDecimal;
import java.util.List;

@JsonInclude(JsonInclude.Include.ALWAYS)
public record TokenUsageView(
    String scope,
    String organizationId,
    int days,
    long inputTokens,
    long outputTokens,
    long totalTokens,
    long cacheReadTokens,
    long cacheWriteTokens,
    long reasoningTokens,
    long llmCalls,
    BigDecimal estimatedCostUsd,
    List<TokenUsageTrendView> trend,
    List<TokenUsageRankView> organizations,
    List<TokenUsageRankView> users,
    List<TokenUsageRankView> models) {}
