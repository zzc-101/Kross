package com.kross.identity.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

@JsonInclude(JsonInclude.Include.ALWAYS)
public record OrganizationPolicyView(String defaultTimezone, Integer dataRetentionDays, JsonNode approvalPolicy) {}
