package com.kross.identity.dto;

import java.util.List;

public record DashboardResponse(
    DashboardCountsView counts,
    UsageView usage,
    List<AgentRuntimeView> agents,
    List<NodeHealthView> nodes) {}
