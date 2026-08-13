package com.kross.identity.dto;

public record DashboardCountsView(int activeMembers, int activeProjects, int activeRuns, int pendingApprovals, int activeConnectors) {}
