package com.kross.agent.dto;

import java.time.Instant;

public record MemoryView(
    String id,
    String kind,
    String source,
    String content,
    Instant createdAt,
    Instant updatedAt) {}
