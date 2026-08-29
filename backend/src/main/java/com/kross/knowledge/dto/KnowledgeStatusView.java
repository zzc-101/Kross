package com.kross.knowledge.dto;

import java.util.List;

public record KnowledgeStatusView(boolean enabled, boolean available, List<String> spaceIds) {}
