package com.kross.catalog.dto;

import com.fasterxml.jackson.databind.JsonNode;

public record UpdateModelRequest(
    String name,
    String provider,
    String model,
    String status,
    String apiKey,
    String baseUrl,
    Integer contextWindow,
    JsonNode configuration) {}
