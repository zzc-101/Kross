package com.kross.identity.entity;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import java.time.Instant;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class Organization {
  private String id;
  private String slug;
  private String name;
  private String status;
  private String defaultTimezone;
  private Integer dataRetentionDays;
  private Instant createdAt;
  private Instant updatedAt;
}
