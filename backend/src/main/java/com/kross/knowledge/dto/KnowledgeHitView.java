package com.kross.knowledge.dto;

public record KnowledgeHitView(
    String documentId, String title, String spaceId, String excerpt, double score, String modality) {}
