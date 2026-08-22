package com.kross.agent.dto;

import com.fasterxml.jackson.databind.JsonNode;

public record UpdateMcpRequest(JsonNode servers) {}
