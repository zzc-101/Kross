package com.kross.identity.dto;

public record BootstrapRequest(String organizationId, String slug, String name, String defaultTimezone) {}
