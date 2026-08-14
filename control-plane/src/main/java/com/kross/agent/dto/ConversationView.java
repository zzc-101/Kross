package com.kross.agent.dto;

import java.time.Instant;

public record ConversationView(
    String id,
    String title,
    Instant archivedAt,
    Instant lastMessageAt,
    Instant createdAt) {}
