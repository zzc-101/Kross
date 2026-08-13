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
public class WorkerToken {
  private String tokenHash;
  private String organizationId;
  private String runId;
  private int generation;
  private String leaseId;
  private String leaseOwner;
  private Instant expiresAt;
  private String workerSessionId;
  private String workerId;
}
