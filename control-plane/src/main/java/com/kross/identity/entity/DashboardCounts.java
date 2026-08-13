package com.kross.identity.entity;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class DashboardCounts {
  private int activeMembers;
  private int activeProjects;
  private int activeRuns;
  private int pendingApprovals;
  private int activeConnectors;
}
