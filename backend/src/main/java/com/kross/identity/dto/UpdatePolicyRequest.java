package com.kross.identity.dto;

import com.fasterxml.jackson.databind.JsonNode;

public record UpdatePolicyRequest(String defaultTimezone, JsonNode dataRetentionDays, JsonNode approvalPolicy) {}
