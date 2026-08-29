package com.kross.knowledge.dto;

import java.time.Instant;

public record KnowledgeJobView(
    String id,
    String documentId,
    String kind,
    String status,
    String errorMessage,
    Instant createdAt,
    Instant updatedAt) {}
