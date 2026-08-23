package com.kross.catalog.entity;

import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
public class TokenUsageRankRow {
  private String id;
  private String name;
  private String secondary;
  private long inputTokens;
  private long outputTokens;
  private long totalTokens;
  private long llmCalls;
}
