package com.kross.agent.dto;

import java.time.Instant;
import java.util.List;

public record WorkspaceListingView(String path, List<WorkspaceEntryView> entries) {}
