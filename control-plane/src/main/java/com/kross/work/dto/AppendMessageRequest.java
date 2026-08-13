package com.kross.work.dto;

import com.fasterxml.jackson.databind.JsonNode;

public record AppendMessageRequest(JsonNode content) {}
