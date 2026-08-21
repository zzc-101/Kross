package com.kross.fleet;

import java.time.Instant;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class WorkerNode {
  private String id;
  private String hostname;
  private String status;
  private int runningAgents;
  private boolean juicefsOk;
  private Instant lastSeenAt;
  private Instant createdAt;
  private Instant updatedAt;
}
