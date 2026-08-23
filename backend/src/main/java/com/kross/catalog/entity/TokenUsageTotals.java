package com.kross.catalog.entity;

import java.math.BigDecimal;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
public class TokenUsageTotals {
  private long inputTokens;
  private long outputTokens;
  private long totalTokens;
  private long cacheReadTokens;
  private long cacheWriteTokens;
  private long reasoningTokens;
  private long llmCalls;
  private BigDecimal estimatedCostUsd;
}
