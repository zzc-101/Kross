package com.kross.catalog.dto;

import com.fasterxml.jackson.databind.JsonNode;

public record CreateModelRequest(String name, String provider, String model, String credentialHandleId, String apiKey, String baseUrl, JsonNode configuration) {}
