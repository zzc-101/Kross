package com.kross.knowledge.dto;

import java.time.Instant;

public record KnowledgeDocumentView(
    String id,
    String spaceId,
    String title,
    String filename,
    String mime,
    String status,
    String createdBy,
    Instant createdAt,
    Instant publishedAt,
    String errorMessage) {}
