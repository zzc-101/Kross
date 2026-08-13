package com.kross.execution.entity;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import java.time.Instant;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class RunLease {
  private String leaseId;
  private String organizationId;
  private String runId;
  private String owner;
  private int generation;
  private Instant expiresAt;
}
