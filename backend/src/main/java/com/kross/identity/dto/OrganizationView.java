package com.kross.identity.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

public record OrganizationView(
    String id,
    String slug,
    String name,
    String status,
    String defaultTimezone,
    Integer dataRetentionDays,
    JsonNode approvalPolicy,
    Instant createdAt,
    Instant updatedAt) {}
