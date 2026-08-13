package com.kross.work.dto;

import com.fasterxml.jackson.databind.JsonNode;

public record CreateExternalSourceRequest(String scope, String taskId, String displayName, String previousSourceId, String kind, String locator, JsonNode origin) {}
