package com.kross.identity.dto;

public record CreateOrganizationRequest(
    String name,
    String slug,
    String defaultTimezone,
    String adminUsername,
    String adminPassword,
    String adminDisplayName) {}
